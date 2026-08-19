//! Prompt 3.3 exit criteria: a lead can list/filter open projects, a
//! volunteer can apply (event signup is the same flow against an
//! event-type project), and a lead's roster approve/remove actions each
//! write exactly one `audit_log` entry.

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use axum::body::Body;
use axum::extract::Path;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use identity_access::{Role, SqlxVolunteerRepository, VolunteerRepository};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use projects_assignments::SqlxProjectRepository;
use serde_json::json;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;
use tower_sessions::Session;
use tower_sessions_sqlx_store_chrono::PostgresStore;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

struct FakeDiscordOAuthClient {
    user: DiscordUserInfo,
}

#[async_trait::async_trait]
impl DiscordOAuthClient for FakeDiscordOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, PkceCodeVerifier) {
        (
            "https://discord.com/api/oauth2/authorize?fake=1".parse().unwrap(),
            CsrfToken::new("fake-discord-csrf".to_string()),
            PkceCodeVerifier::new("fake-pkce-verifier".to_string()),
        )
    }
    async fn exchange_code(&self, _code: String, _v: PkceCodeVerifier) -> Result<String, OAuthError> {
        Ok("fake-discord-access-token".to_string())
    }
    async fn fetch_user(&self, _access_token: &str) -> Result<DiscordUserInfo, OAuthError> {
        Ok(self.user.clone())
    }
}

struct UnusedGoogleOAuthClient;
#[async_trait::async_trait]
impl GoogleOAuthClient for UnusedGoogleOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce) {
        unimplemented!("not exercised by the projects test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the projects test suite")
    }
}

fn first_cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

async fn setup() -> (
    testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    PgPool,
    PgPool,
) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();
    (container, owner_pool, app_pool)
}

async fn test_login(session: Session, Path(volunteer_id): Path<uuid::Uuid>) -> impl IntoResponse {
    session
        .insert(api::auth::SESSION_VOLUNTEER_ID_KEY, volunteer_id)
        .await
        .unwrap();
    StatusCode::OK
}

async fn build_test_app(owner_pool: &PgPool, app_pool: PgPool, discord_user: DiscordUserInfo) -> axum::Router {
    let session_store = PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = api::session::configure(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        discord_oauth: Arc::new(FakeDiscordOAuthClient { user: discord_user }),
        google_oauth: Some(Arc::new(UnusedGoogleOAuthClient)),
    };

    api::build_router(state.clone())
        .merge(
            axum::Router::new()
                .route("/test/login/{volunteer_id}", post(test_login))
                .with_state(state),
        )
        .layer(session_layer)
}

async fn test_login_as(app: &axum::Router, volunteer_id: uuid::Uuid) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/test/login/{volunteer_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    first_cookie_pair(response.headers().get("set-cookie").unwrap().to_str().unwrap())
}

async fn login(app: &axum::Router, owner_pool: &PgPool, discord_id: &str) -> (String, uuid::Uuid) {
    let login_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/login")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = first_cookie_pair(login_response.headers().get("set-cookie").unwrap().to_str().unwrap());

    let callback_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/callback?code=x&state=fake-discord-csrf")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let session_cookie =
        first_cookie_pair(callback_response.headers().get("set-cookie").unwrap().to_str().unwrap());

    let volunteer_id: uuid::Uuid =
        sqlx::query_scalar("select id from volunteer where discord_id = $1")
            .bind(discord_id)
            .fetch_one(owner_pool)
            .await
            .unwrap();

    (session_cookie, volunteer_id)
}

/// Promotes a volunteer to `Lead` directly via the repository (bypassing
/// HTTP -- admin-driven role changes are Phase 8's concern, not this
/// prompt's).
async fn promote_to_lead(app_pool: &PgPool, volunteer_id: uuid::Uuid) {
    let db = kernel::ScopedDb::new(app_pool.clone());
    let repo = SqlxVolunteerRepository;
    let id = kernel::Id::from_uuid(volunteer_id);
    let mut tx = db.begin_scoped(volunteer_id).await.unwrap();
    let mut volunteer = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    volunteer.change_role(Role::Lead, id).unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();
}

async fn promote_to_admin(app_pool: &PgPool, volunteer_id: uuid::Uuid) {
    let db = kernel::ScopedDb::new(app_pool.clone());
    let repo = SqlxVolunteerRepository;
    let id = kernel::Id::from_uuid(volunteer_id);
    let mut tx = db.begin_scoped(volunteer_id).await.unwrap();
    let mut volunteer = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    volunteer.change_role(Role::Admin, id).unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();
}

async fn create_open_project(app: &axum::Router, lead_cookie: &str, skill: &str) -> uuid::Uuid {
    let body = json!({
        "name": "Trail Cleanup",
        "description": "Clear brush from the east trail",
        "is_event": false,
        "needed_skills": [skill],
        "next_occurrence_at": null,
        "recurrence_note": null,
    });
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/projects")
                .header("cookie", lead_cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let id_str: String = serde_json::from_slice(&bytes).unwrap();
    id_str.parse().unwrap()
}

#[tokio::test]
async fn non_lead_cannot_create_a_project() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "plain-volunteer".to_string(),
            username: "plain".to_string(),
            email: Some("plain@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (cookie, _id) = login(&app, &owner_pool, "plain-volunteer").await;

    let body = json!({
        "name": "Trail Cleanup",
        "description": "Clear brush",
        "is_event": false,
        "needed_skills": [],
        "next_occurrence_at": null,
        "recurrence_note": null,
    });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/projects")
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn directory_filters_open_projects_by_skill() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "lead-directory".to_string(),
            username: "lead".to_string(),
            email: Some("lead-directory@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (lead_cookie, lead_id) = login(&app, &owner_pool, "lead-directory").await;
    promote_to_lead(&app_pool, lead_id).await;

    create_open_project(&app, &lead_cookie, "Carpentry").await;

    let matching = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/projects?skill=Carpentry")
                .header("cookie", &lead_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(matching.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(matching.into_body(), usize::MAX).await.unwrap();
    let projects: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(projects.len(), 1);

    let non_matching = app
        .oneshot(
            Request::builder()
                .uri("/projects?skill=Welding")
                .header("cookie", &lead_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(non_matching.into_body(), usize::MAX).await.unwrap();
    let projects: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(projects.len(), 0);
}

#[tokio::test]
async fn volunteer_applies_then_lead_approve_and_remove_each_write_one_audit_log_entry() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "lead-roster".to_string(),
            username: "lead".to_string(),
            email: Some("lead-roster@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (lead_cookie, lead_id) = login(&app, &owner_pool, "lead-roster").await;
    promote_to_lead(&app_pool, lead_id).await;

    let project_id = create_open_project(&app, &lead_cookie, "Carpentry").await;

    // A second identity applies as a volunteer.
    let discord_user = DiscordUserInfo {
        id: "applicant".to_string(),
        username: "applicant".to_string(),
        email: Some("applicant@example.org".to_string()),
        verified: true,
    };
    // FakeDiscordOAuthClient is fixed per-app to one user, so log the
    // applicant in via the test-only session shortcut instead of a
    // second real OAuth round trip: seed the volunteer with a direct
    // login+callback against a *second* app pointed at the same
    // database, then reuse the resulting id against the first app's
    // router (both share `owner_pool`/`app_pool`).
    let applicant_app = build_test_app(&owner_pool, app_pool.clone(), discord_user).await;
    let (_applicant_cookie_unused, applicant_id) = login(&applicant_app, &owner_pool, "applicant").await;
    let applicant_cookie = test_login_as(&app, applicant_id).await;

    let apply_body = json!({ "role": "Carpenter" });
    let apply_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/apply"))
                .header("cookie", &applicant_cookie)
                .header("content-type", "application/json")
                .body(Body::from(apply_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(apply_response.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(apply_response.into_body(), usize::MAX).await.unwrap();
    let assignment_id_str: String = serde_json::from_slice(&bytes).unwrap();
    let assignment_id: uuid::Uuid = assignment_id_str.parse().unwrap();

    // Roster is visible to the lead and shows the pending application.
    let roster_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/projects/{project_id}/roster"))
                .header("cookie", &lead_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(roster_response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(roster_response.into_body(), usize::MAX).await.unwrap();
    let roster: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(roster.len(), 1);
    assert_eq!(roster[0]["status"], "applied");

    // A non-lead cannot see or act on the roster.
    let forbidden = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/projects/{project_id}/roster"))
                .header("cookie", &applicant_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let approval_audit_query =
        "select count(*) from audit_log where action = 'updated' and entity_type = 'assignment' and entity_id = $1";
    let before: i64 = sqlx::query_scalar(approval_audit_query)
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(before, 0);

    let approve_body = json!({ "assignment_id": assignment_id, "reason": null });
    let approve_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/assignments/approve"))
                .header("cookie", &lead_cookie)
                .header("content-type", "application/json")
                .body(Body::from(approve_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(approve_response.status(), StatusCode::NO_CONTENT);

    let after_approve: i64 = sqlx::query_scalar(approval_audit_query)
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(
        after_approve, 1,
        "approving an assignment must write exactly one audit_log entry"
    );

    // `AssignmentRemoved` is a soft-remove (status flips, no row is
    // physically deleted) but audits as `AuditAction::Deleted` in the
    // compliance sense (projects-assignments.md), not `Updated` -- a
    // separate action from the approval above, so it's counted with its
    // own query rather than the `action = 'updated'` one.
    let removal_audit_query =
        "select count(*) from audit_log where action = 'deleted' and entity_type = 'assignment' and entity_id = $1";
    let removal_before: i64 = sqlx::query_scalar(removal_audit_query)
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(removal_before, 0);

    let remove_body = json!({ "assignment_id": assignment_id, "reason": "no longer needed" });
    let remove_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/assignments/remove"))
                .header("cookie", &lead_cookie)
                .header("content-type", "application/json")
                .body(Body::from(remove_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(remove_response.status(), StatusCode::NO_CONTENT);

    let removal_after: i64 = sqlx::query_scalar(removal_audit_query)
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(
        removal_after, 1,
        "removing an assignment must write exactly one audit_log entry with action = 'deleted'"
    );

    // The earlier approval's own audit row is untouched by the removal.
    let after_remove: i64 = sqlx::query_scalar(approval_audit_query)
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(after_remove, 1);

    let status: String = sqlx::query_scalar("select status from assignment where id = $1")
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(status, "removed");
}

/// concept.md section 2's "Admins have global scope": an admin who is
/// *not* personally a `project_lead` row of this project must still be
/// able to view the roster and approve an application -- `LeadOfOrAdmin`
/// exists specifically to close this gap (an architect review of Phase 3
/// found `LeadOf` alone under-authorized admins relative to concept.md
/// and the `assignment_select`/`assignment_update` RLS policies, which
/// already grant `current_actor_role() = 'admin'` as an alternative to
/// lead membership).
#[tokio::test]
async fn admin_without_lead_membership_can_view_and_approve_roster() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "lead-for-admin-test".to_string(),
            username: "lead".to_string(),
            email: Some("lead-for-admin-test@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (lead_cookie, lead_id) = login(&app, &owner_pool, "lead-for-admin-test").await;
    promote_to_lead(&app_pool, lead_id).await;
    let project_id = create_open_project(&app, &lead_cookie, "Carpentry").await;

    let applicant_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "applicant-for-admin-test".to_string(),
            username: "applicant".to_string(),
            email: Some("applicant-for-admin-test@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, applicant_id) = login(&applicant_app, &owner_pool, "applicant-for-admin-test").await;
    let applicant_cookie = test_login_as(&app, applicant_id).await;

    let apply_body = json!({ "role": "Carpenter" });
    let apply_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/apply"))
                .header("cookie", &applicant_cookie)
                .header("content-type", "application/json")
                .body(Body::from(apply_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(apply_response.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(apply_response.into_body(), usize::MAX).await.unwrap();
    let assignment_id_str: String = serde_json::from_slice(&bytes).unwrap();
    let assignment_id: uuid::Uuid = assignment_id_str.parse().unwrap();

    // A third identity is an admin, but was never added to this
    // project's `project_lead` table.
    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "admin-not-a-lead".to_string(),
            username: "admin".to_string(),
            email: Some("admin-not-a-lead@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, admin_id) = login(&admin_app, &owner_pool, "admin-not-a-lead").await;
    promote_to_admin(&app_pool, admin_id).await;
    let admin_cookie = test_login_as(&app, admin_id).await;

    let roster_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/projects/{project_id}/roster"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        roster_response.status(),
        StatusCode::OK,
        "an admin with no project_lead row must still be able to view the roster"
    );

    let approve_body = json!({ "assignment_id": assignment_id, "reason": null });
    let approve_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/projects/{project_id}/assignments/approve"))
                .header("cookie", &admin_cookie)
                .header("content-type", "application/json")
                .body(Body::from(approve_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        approve_response.status(),
        StatusCode::NO_CONTENT,
        "an admin with no project_lead row must still be able to approve an assignment"
    );

    let status: String = sqlx::query_scalar("select status from assignment where id = $1")
        .bind(assignment_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(status, "approved");
}
