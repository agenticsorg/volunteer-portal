//! Prompt 4.2 exit criteria: approval actions are lead-scoped and
//! enforced server-side (not just hidden in the UI), manual adjustments
//! write an `audit_log` entry carrying the specific before/after `Hours`
//! shape (not just *an* audit row), and the event-hours invariant is
//! re-verified at the API layer -- logging hours against an ineligible
//! (`Attendee`-mode) assignment returns a clean 4xx, not a 500.

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
        unimplemented!("not exercised by the hours test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the hours test suite")
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
        project_names: Arc::new(api::project_name_adapter::ProjectsAssignmentsNameAdapter),
        discord_interactions_public_key: "test-public-key".to_string(),
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

/// Seeds an approved `Contributor`-mode assignment directly (bypassing
/// HTTP -- the apply+approve HTTP flow is Prompt 3.3's own coverage) so
/// hours can be logged against it.
async fn seed_approved_contributor_assignment(
    owner_pool: &PgPool,
    volunteer_id: uuid::Uuid,
    lead_id: uuid::Uuid,
) -> uuid::Uuid {
    let project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) \
         values ('Trail Cleanup', '', 'project', 'open') returning id",
    )
    .fetch_one(owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(project_id)
        .bind(lead_id)
        .execute(owner_pool)
        .await
        .unwrap();
    sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status, decided_by, decided_at) \
         values ($1, $2, 'Volunteer', 'contributor', 'approved', $3, now()) returning id",
    )
    .bind(volunteer_id)
    .bind(project_id)
    .bind(lead_id)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn logging_hours_against_an_ineligible_attendee_assignment_returns_400_not_500() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "event-attendee".to_string(),
            username: "attendee".to_string(),
            email: Some("event-attendee@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (cookie, volunteer_id) = login(&app, &owner_pool, "event-attendee").await;

    let event_project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, type, next_occurrence_at) \
         values ('Weekly Meetup', 'event', now() + interval '7 days') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let attendee_assignment_id: uuid::Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Attendee', 'attendee', 'approved') returning id",
    )
    .bind(volunteer_id)
    .bind(event_project_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let body = json!({ "date": "2026-01-15", "hours": "2.0", "description": "Attended" });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/assignments/{attendee_assignment_id}/hours"))
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an ineligible (Attendee-mode) assignment must be refused with a clean 4xx, not a 500"
    );

    let count: i64 = sqlx::query_scalar("select count(*) from hour_entry")
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn bulk_approve_is_lead_scoped_and_enforced_server_side() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "hours-lead".to_string(),
            username: "lead".to_string(),
            email: Some("hours-lead@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_lead_cookie, lead_id) = login(&app, &owner_pool, "hours-lead").await;
    promote_to_lead(&app_pool, lead_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "hours-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("hours-volunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, volunteer_id) = login(&volunteer_app, &owner_pool, "hours-volunteer").await;
    let volunteer_cookie = test_login_as(&app, volunteer_id).await;

    let assignment_id = seed_approved_contributor_assignment(&owner_pool, volunteer_id, lead_id).await;

    let log_body = json!({ "date": "2026-01-15", "hours": "3.0", "description": "Cleared brush" });
    let log_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/assignments/{assignment_id}/hours"))
                .header("cookie", &volunteer_cookie)
                .header("content-type", "application/json")
                .body(Body::from(log_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(log_response.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(log_response.into_body(), usize::MAX).await.unwrap();
    let entry_id_str: String = serde_json::from_slice(&bytes).unwrap();
    let entry_id: uuid::Uuid = entry_id_str.parse().unwrap();

    // A stranger -- not a lead of this project, not an admin -- attempts
    // to bulk-approve it via the real HTTP endpoint.
    let stranger_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "hours-stranger".to_string(),
            username: "stranger".to_string(),
            email: Some("hours-stranger@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, stranger_id) = login(&stranger_app, &owner_pool, "hours-stranger").await;
    let stranger_cookie = test_login_as(&app, stranger_id).await;

    let bulk_body = json!({ "hour_entry_ids": [entry_id] });
    let bulk_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/hours/approve")
                .header("cookie", &stranger_cookie)
                .header("content-type", "application/json")
                .body(Body::from(bulk_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bulk_response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(bulk_response.into_body(), usize::MAX).await.unwrap();
    let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["approved"].as_array().unwrap().len(), 0);
    assert_eq!(result["failed"].as_array().unwrap().len(), 1);

    let status: String = sqlx::query_scalar("select status from hour_entry where id = $1")
        .bind(entry_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(
        status, "pending",
        "server-side authorization must reject the stranger's approval, not just the UI"
    );

    // The actual lead's bulk-approve of the same entry succeeds.
    let lead_cookie = test_login_as(&app, lead_id).await;
    let lead_bulk_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/hours/approve")
                .header("cookie", &lead_cookie)
                .header("content-type", "application/json")
                .body(Body::from(bulk_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(lead_bulk_response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(lead_bulk_response.into_body(), usize::MAX).await.unwrap();
    let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["approved"].as_array().unwrap().len(), 1);

    let status: String = sqlx::query_scalar("select status from hour_entry where id = $1")
        .bind(entry_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(status, "approved");
}

#[tokio::test]
async fn admin_adjustment_writes_audit_log_with_exact_before_and_after_hours() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "adjustment-lead".to_string(),
            username: "lead".to_string(),
            email: Some("adjustment-lead@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_lead_cookie, lead_id) = login(&app, &owner_pool, "adjustment-lead").await;
    promote_to_lead(&app_pool, lead_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "adjustment-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("adjustment-volunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, volunteer_id) = login(&volunteer_app, &owner_pool, "adjustment-volunteer").await;
    let volunteer_cookie = test_login_as(&app, volunteer_id).await;

    let assignment_id = seed_approved_contributor_assignment(&owner_pool, volunteer_id, lead_id).await;

    let log_body = json!({ "date": "2026-01-15", "hours": "2.0", "description": "Setup" });
    let log_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/assignments/{assignment_id}/hours"))
                .header("cookie", &volunteer_cookie)
                .header("content-type", "application/json")
                .body(Body::from(log_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(log_response.into_body(), usize::MAX).await.unwrap();
    let entry_id_str: String = serde_json::from_slice(&bytes).unwrap();
    let entry_id: uuid::Uuid = entry_id_str.parse().unwrap();

    let lead_cookie = test_login_as(&app, lead_id).await;
    let approve_body = json!({ "hour_entry_ids": [entry_id] });
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/hours/approve")
                .header("cookie", &lead_cookie)
                .header("content-type", "application/json")
                .body(Body::from(approve_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // An admin (not the lead -- concept.md section 8 places manual
    // adjustment under Admin, not project leads) is seeded directly.
    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "adjustment-admin".to_string(),
            username: "admin".to_string(),
            email: Some("adjustment-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, admin_id) = login(&admin_app, &owner_pool, "adjustment-admin").await;
    promote_to_admin(&app_pool, admin_id).await;
    let admin_cookie = test_login_as(&app, admin_id).await;

    // A lead attempting the same adjustment is refused -- admin only.
    let adjust_body = json!({ "new_hours": "4.0", "reason": "Undercounted setup time" });
    let lead_attempt = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/hours/{entry_id}/adjust"))
                .header("cookie", &lead_cookie)
                .header("content-type", "application/json")
                .body(Body::from(adjust_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(lead_attempt.status(), StatusCode::FORBIDDEN);

    let adjust_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/hours/{entry_id}/adjust"))
                .header("cookie", &admin_cookie)
                .header("content-type", "application/json")
                .body(Body::from(adjust_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(adjust_response.status(), StatusCode::NO_CONTENT);

    let (action, entity_type, entity_id, before, after): (
        String,
        String,
        uuid::Uuid,
        serde_json::Value,
        serde_json::Value,
    ) = sqlx::query_as(
        "select action, entity_type, entity_id, before, after from audit_log where action = 'hour_adjusted'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    assert_eq!(action, "hour_adjusted");
    assert_eq!(entity_type, "hour_entry");
    assert_eq!(entity_id, entry_id);
    // The specific HoursAdjusted shape: explicit before/after Hours
    // values, not a generic diff. `before` is the DB-round-tripped
    // value (numeric(4,2), scale 2); `after` is the raw request input
    // (never round-tripped before the event is built), so their scales
    // legitimately differ ("2.00" vs "4.0") while both represent the
    // correct numeric value.
    assert_eq!(before["hours"], json!("2.00"));
    assert_eq!(after["hours"], json!("4.0"));
    assert_eq!(after["reason"], json!("Undercounted setup time"));

    let hours: rust_decimal::Decimal = sqlx::query_scalar("select hours from hour_entry where id = $1")
        .bind(entry_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(hours, rust_decimal::Decimal::new(400, 2));
}
