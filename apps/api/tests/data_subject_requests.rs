//! Prompt 10.2's exit criterion: "A test suite asserts both directions of
//! the anonymization requirement: the anonymized fields are genuinely
//! unrecoverable (no soft-delete flag hiding original values anywhere),
//! and every FK that referenced the volunteer still resolves without
//! error after anonymization."

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use identity_access::{Role, SqlxVolunteerRepository, VolunteerRepository};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use projects_assignments::SqlxProjectRepository;
use serde_json::{json, Value};
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;

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
        unimplemented!("not exercised by the data-subject-requests test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the data-subject-requests test suite")
    }
}

fn first_cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

async fn setup() -> (testcontainers_modules::testcontainers::ContainerAsync<Postgres>, PgPool, PgPool) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();
    (container, owner_pool, app_pool)
}

async fn build_test_app(owner_pool: &PgPool, app_pool: PgPool, discord_user: DiscordUserInfo) -> axum::Router {
    let session_store = tower_sessions_sqlx_store_chrono::PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = api::session::configure(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        project_names: Arc::new(api::project_name_adapter::ProjectsAssignmentsNameAdapter),
        semantic_match: Arc::new(api::semantic_matching_client::NullSemanticMatchClient),
        discord_interactions_public_key: "test-public-key".to_string(),
        discord_oauth: Arc::new(FakeDiscordOAuthClient { user: discord_user }),
        google_oauth: Some(Arc::new(UnusedGoogleOAuthClient)),
    };

    api::build_router(state).layer(session_layer)
}

async fn login(app: &axum::Router, owner_pool: &PgPool, discord_id: &str) -> (String, uuid::Uuid) {
    let login_response =
        app.clone().oneshot(Request::builder().uri("/auth/discord/login").body(Body::empty()).unwrap()).await.unwrap();
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
    let session_cookie = first_cookie_pair(callback_response.headers().get("set-cookie").unwrap().to_str().unwrap());

    let volunteer_id: uuid::Uuid = sqlx::query_scalar("select id from volunteer where discord_id = $1")
        .bind(discord_id)
        .fetch_one(owner_pool)
        .await
        .unwrap();

    (session_cookie, volunteer_id)
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

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn full_deletion_lifecycle_anonymizes_the_volunteer_and_preserves_every_fk() {
    let (_container, owner_pool, app_pool) = setup().await;

    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "dsr-admin".to_string(),
            username: "admin".to_string(),
            email: Some("dsr-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_admin_cookie, admin_id) = login(&admin_app, &owner_pool, "dsr-admin").await;
    promote_to_admin(&app_pool, admin_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "dsr-target".to_string(),
            username: "target".to_string(),
            email: Some("dsr-target@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (volunteer_cookie, volunteer_id) = login(&volunteer_app, &owner_pool, "dsr-target").await;

    // Give the volunteer a real, distinctive name/email/country/skill so
    // "genuinely unrecoverable" is a meaningful assertion, and seed a
    // project/assignment/hour_entry that reference this volunteer, plus
    // let the signup flow's own audit_log rows accumulate (actor_id =
    // this volunteer) -- exactly the FK surface the exit criterion names.
    let original_email = "unmistakable-original-email@example.org";
    sqlx::query(
        "update volunteer set name = 'Ada Deletable Lovelace', email = $2, \
         skills = array['carpentry'], country_region = 'Germany', status = 'approved', \
         code_of_conduct_accepted_at = now(), ip_agreement_accepted_at = now(), \
         age_attestation_confirmed_at = now() \
         where id = $1",
    )
    .bind(volunteer_id)
    .bind(original_email)
    .execute(&owner_pool)
    .await
    .unwrap();

    let project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) \
         values ('DSR Test Project', 'carpentry work', 'project', 'open') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let assignment_id: uuid::Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status, decided_by, decided_at) \
         values ($1, $2, 'Volunteer', 'contributor', 'approved', $3, now()) returning id",
    )
    .bind(volunteer_id)
    .bind(project_id)
    .bind(admin_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let hour_entry_id: uuid::Uuid = sqlx::query_scalar(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description, status, approver_id, decided_at) \
         values ($1, $2, current_date, 3.5, 'built a bench', 'approved', $3, now()) returning id",
    )
    .bind(volunteer_id)
    .bind(assignment_id)
    .bind(admin_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let pre_audit_log_count_for_actor: i64 =
        sqlx::query_scalar("select count(*) from audit_log where actor_id = $1")
            .bind(volunteer_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert!(pre_audit_log_count_for_actor > 0, "signup must already have produced at least one audit_log row");

    let identity_row_count_before: i64 =
        sqlx::query_scalar("select count(*) from identity where volunteer_id = $1")
            .bind(volunteer_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(identity_row_count_before, 1, "the discord OAuth link must have been persisted");

    // File the deletion request as the volunteer, then run it through
    // the admin queue (start -> complete) using the *admin*'s app/cookie.
    let file_response = volunteer_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/data-subject-requests")
                .header("cookie", &volunteer_cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "request_type": "deletion" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(file_response.status(), StatusCode::CREATED);
    let filed = body_json(file_response).await;
    let request_id = filed["id"].as_str().unwrap().to_string();
    assert_eq!(filed["status"], "received");

    let start_response = admin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/start"))
                .header("cookie", &_admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start_response.status(), StatusCode::OK);
    let started = body_json(start_response).await;
    assert_eq!(started["status"], "in_progress");
    assert_eq!(started["handled_by"], admin_id.to_string());

    let complete_response = admin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/complete"))
                .header("cookie", &_admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(complete_response.status(), StatusCode::OK);
    let completed = body_json(complete_response).await;
    assert_eq!(completed["request"]["status"], "completed");
    assert!(completed["export"].is_null(), "a Deletion completion must not return an export data package");

    // Direction 1: genuinely unrecoverable -- no trace of the original
    // identifying values survives anywhere in `volunteer` or `identity`.
    let row: (String, String, Option<String>, Vec<String>, Option<String>, String) = sqlx::query_as(
        "select name, email, discord_id, skills, country_region, status from volunteer where id = $1",
    )
    .bind(volunteer_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let (name, email, discord_id, skills, country_region, status) = row;
    assert_eq!(name, "[deleted volunteer]");
    assert_ne!(email, original_email);
    assert!(email.starts_with("deleted-") && email.ends_with("@invalid"));
    assert_eq!(discord_id, None);
    assert!(skills.is_empty());
    assert_eq!(country_region, None);
    assert_eq!(status, "suspended");

    let identity_row_count_after: i64 =
        sqlx::query_scalar("select count(*) from identity where volunteer_id = $1")
            .bind(volunteer_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(identity_row_count_after, 0, "identity rows (which carry email_at_link_time PII) must be removed");

    // The original values must not be recoverable from *anywhere* --
    // not a soft-delete flag, not a leftover row.
    let leaked_email: i64 = sqlx::query_scalar(
        "select count(*) from volunteer where email = $1 or name = 'Ada Deletable Lovelace'",
    )
    .bind(original_email)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(leaked_email, 0);

    // Direction 2: every FK that referenced the volunteer still resolves
    // without error -- assignment, hour_entry, and every audit_log row
    // (including the ones from signup/approval, predating anonymization)
    // are all still present and still join back to `volunteer.id`.
    let assignment_still_resolves: i64 = sqlx::query_scalar(
        "select count(*) from assignment a join volunteer v on v.id = a.volunteer_id where a.id = $1",
    )
    .bind(assignment_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(assignment_still_resolves, 1);

    let hour_entry_still_resolves: i64 = sqlx::query_scalar(
        "select count(*) from hour_entry h join volunteer v on v.id = h.volunteer_id where h.id = $1",
    )
    .bind(hour_entry_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(hour_entry_still_resolves, 1);

    let audit_log_actor_still_resolves: i64 = sqlx::query_scalar(
        "select count(*) from audit_log al join volunteer v on v.id = al.actor_id where al.actor_id = $1",
    )
    .bind(volunteer_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    // +1 for `DataSubjectRequestReceived` itself, whose actor is the
    // requesting volunteer (self-action, same shape as
    // `VolunteerOnboarded`) -- `Completed`/`VolunteerAnonymized` are
    // both actored by the admin, not the volunteer, so they don't add
    // further rows to this count.
    assert_eq!(
        audit_log_actor_still_resolves, pre_audit_log_count_for_actor + 1,
        "every pre-anonymization audit_log row referencing this volunteer as actor must still resolve"
    );

    // The VolunteerAnonymized event itself is audit-logged, distinct
    // from the DataSubjectRequestReceived/Completed rows.
    let volunteer_anonymized_rows: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where entity_type = 'volunteer' and entity_id = $1 \
         and action = 'updated' and after->>'anonymized' = 'true'",
    )
    .bind(volunteer_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(volunteer_anonymized_rows, 1);

    let request_lifecycle_rows: i64 =
        sqlx::query_scalar("select count(*) from audit_log where entity_type = 'data_subject_request'")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(request_lifecycle_rows, 2, "one Received (Created) row and one Completed (Updated) row");
}

#[tokio::test]
async fn export_completion_returns_a_data_package_and_never_mutates_the_volunteer() {
    let (_container, owner_pool, app_pool) = setup().await;

    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "export-admin".to_string(),
            username: "admin".to_string(),
            email: Some("export-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (admin_cookie, admin_id) = login(&admin_app, &owner_pool, "export-admin").await;
    promote_to_admin(&app_pool, admin_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "export-target".to_string(),
            username: "target".to_string(),
            email: Some("export-target@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (volunteer_cookie, volunteer_id) = login(&volunteer_app, &owner_pool, "export-target").await;

    let file_response = volunteer_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/data-subject-requests")
                .header("cookie", &volunteer_cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "request_type": "export" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let filed = body_json(file_response).await;
    let request_id = filed["id"].as_str().unwrap().to_string();

    admin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/start"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let complete_response = admin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/complete"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(complete_response.status(), StatusCode::OK);
    let completed = body_json(complete_response).await;
    assert_eq!(completed["request"]["status"], "completed");
    assert!(!completed["export"].is_null());
    assert_eq!(completed["export"]["volunteer"]["id"], volunteer_id.to_string());

    let status: String = sqlx::query_scalar("select status from volunteer where id = $1")
        .bind(volunteer_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_ne!(status, "suspended", "an Export request must never anonymize the volunteer");
}

#[tokio::test]
async fn only_an_admin_can_administer_a_data_subject_request() {
    let (_container, owner_pool, app_pool) = setup().await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "not-admin".to_string(),
            username: "not-admin".to_string(),
            email: Some("not-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (volunteer_cookie, _volunteer_id) = login(&volunteer_app, &owner_pool, "not-admin").await;

    let file_response = volunteer_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/data-subject-requests")
                .header("cookie", &volunteer_cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "request_type": "export" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let filed = body_json(file_response).await;
    let request_id = filed["id"].as_str().unwrap().to_string();

    let start_response = volunteer_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/start"))
                .header("cookie", &volunteer_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start_response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn rejecting_a_request_requires_a_non_empty_reason() {
    let (_container, owner_pool, app_pool) = setup().await;

    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "reject-admin".to_string(),
            username: "admin".to_string(),
            email: Some("reject-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (admin_cookie, admin_id) = login(&admin_app, &owner_pool, "reject-admin").await;
    promote_to_admin(&app_pool, admin_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "reject-target".to_string(),
            username: "target".to_string(),
            email: Some("reject-target@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (volunteer_cookie, _volunteer_id) = login(&volunteer_app, &owner_pool, "reject-target").await;

    let file_response = volunteer_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/data-subject-requests")
                .header("cookie", &volunteer_cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "request_type": "deletion" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let filed = body_json(file_response).await;
    let request_id = filed["id"].as_str().unwrap().to_string();

    let empty_reject_response = admin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/reject"))
                .header("cookie", &admin_cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "reason": "   " }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(empty_reject_response.status(), StatusCode::BAD_REQUEST);

    let real_reject_response = admin_app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/data-subject-requests/{request_id}/reject"))
                .header("cookie", &admin_cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "reason": "open code-of-conduct investigation" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(real_reject_response.status(), StatusCode::OK);
    let rejected = body_json(real_reject_response).await;
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["rejection_reason"], "open code-of-conduct investigation");
}
