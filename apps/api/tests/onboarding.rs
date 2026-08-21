//! Prompt 2.3 exit criteria: agreement acceptances are stored with
//! timestamps and queryable per volunteer; admin approval writes exactly
//! one AuditLog entry (verified by test, not just by inspection).

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use projects_assignments::SqlxProjectRepository;
use axum::body::Body;
use axum::extract::Path;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use identity_access::{Role, SqlxVolunteerRepository, Volunteer, VolunteerRepository};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
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

/// Not exercised by these tests, but AppState requires a value.
struct UnusedGoogleOAuthClient;
#[async_trait::async_trait]
impl GoogleOAuthClient for UnusedGoogleOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce) {
        unimplemented!("not exercised by the onboarding test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the onboarding test suite")
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

/// Test-only handler: sets the caller's session directly, standing in
/// for a real login -- used to authenticate as a *second* identity (the
/// admin) without needing a second fake OAuth client wired into the same
/// `AppState`.
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
        semantic_match: Arc::new(api::semantic_matching_client::NullSemanticMatchClient),
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

/// Logs a fresh Discord identity in via the real login+callback flow and
/// returns (session cookie, volunteer_id).
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

#[tokio::test]
async fn onboarding_stores_agreement_timestamps_queryable_per_volunteer() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "onboarding-volunteer".to_string(),
            username: "newvolunteer".to_string(),
            email: Some("newvolunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;

    let (cookie, volunteer_id) = login(&app, &owner_pool, "onboarding-volunteer").await;

    let before: i64 = sqlx::query_scalar(
        "select count(*) from volunteer where id = $1 and code_of_conduct_accepted_at is not null",
    )
    .bind(volunteer_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(before, 0, "agreements must not be set before onboarding completes");

    let body = json!({
        "name": "New Volunteer",
        "timezone": "America/Toronto",
        "skills": ["Rust", "Figma"],
        "availability": {"weekday_evenings": true},
        "country_region": "CA-ON",
        "code_of_conduct_accepted": true,
        "ip_agreement_accepted": true,
        "age_attestation_confirmed": true,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/onboarding")
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // Queryable per volunteer, per the exit criterion: every agreement
    // timestamp is set, plus the profile fields and country_region.
    type AgreementsRow = (
        Option<chrono::DateTime<chrono::Utc>>,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<String>,
        String,
    );
    let row: AgreementsRow = sqlx::query_as(
        "select code_of_conduct_accepted_at, ip_agreement_accepted_at, age_attestation_confirmed_at, country_region, timezone
         from volunteer where id = $1",
    )
    .bind(volunteer_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    assert!(row.0.is_some(), "code_of_conduct_accepted_at must be set");
    assert!(row.1.is_some(), "ip_agreement_accepted_at must be set");
    assert!(row.2.is_some(), "age_attestation_confirmed_at must be set");
    assert_eq!(row.3.as_deref(), Some("CA-ON"));
    assert_eq!(row.4, "America/Toronto");
}

#[tokio::test]
async fn onboarding_rejects_incomplete_agreements() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "incomplete-agreements".to_string(),
            username: "incomplete".to_string(),
            email: Some("incomplete@example.org".to_string()),
            verified: true,
        },
    )
    .await;

    let (cookie, _volunteer_id) = login(&app, &owner_pool, "incomplete-agreements").await;

    let body = json!({
        "name": "Incomplete",
        "timezone": "UTC",
        "skills": [],
        "availability": {},
        "country_region": null,
        "code_of_conduct_accepted": true,
        "ip_agreement_accepted": false,
        "age_attestation_confirmed": true,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/onboarding")
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn admin_approval_writes_exactly_one_audit_log_entry() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "target-for-approval".to_string(),
            username: "target".to_string(),
            email: Some("target@example.org".to_string()),
            verified: true,
        },
    )
    .await;

    let (target_cookie, target_id) = login(&app, &owner_pool, "target-for-approval").await;

    // Complete onboarding first (approve() refuses incomplete Agreements).
    let body = json!({
        "name": "Target",
        "timezone": "UTC",
        "skills": [],
        "availability": {},
        "country_region": null,
        "code_of_conduct_accepted": true,
        "ip_agreement_accepted": true,
        "age_attestation_confirmed": true,
    });
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/volunteers/me/onboarding")
                .header("cookie", &target_cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Seed an admin directly (bypassing HTTP -- promoting to admin isn't
    // itself in scope for this prompt) and log in as them.
    {
        let mut admin = Volunteer::signup(
            "Admin".to_string(),
            "admin-approver@example.org".to_string(),
            "UTC".to_string(),
            vec![],
            identity_access::Availability::empty(),
            identity_access::OAuthProvider::Discord,
            "admin-approver-discord".to_string(),
            "admin-approver@example.org".to_string(),
            true,
        )
        .unwrap();
        admin.change_role(Role::Admin, admin.id()).unwrap();
        let db = kernel::ScopedDb::new(app_pool);
        let repo = SqlxVolunteerRepository;
        let mut tx = db.begin_scoped(admin.id().as_uuid()).await.unwrap();
        repo.save(&mut tx, &mut admin).await.unwrap();
        tx.commit().await.unwrap();
    }

    let admin_id: uuid::Uuid =
        sqlx::query_scalar("select id from volunteer where discord_id = 'admin-approver-discord'")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let admin_cookie = test_login_as(&app, admin_id).await;

    // Baseline includes the two VolunteerOnboarded (Created) rows from
    // the target's and admin's own signups -- the exit criterion is
    // "exactly one entry *for this approval*," not "the table starts
    // empty," so the assertion below checks the specific
    // (action, entity_type, entity_id) row this mutation should produce,
    // both that it didn't exist before and that there's exactly one
    // after.
    let approval_audit_query = "select count(*) from audit_log \
         where action = 'updated' and entity_type = 'volunteer' and entity_id = $1";

    let approval_rows_before: i64 = sqlx::query_scalar(approval_audit_query)
        .bind(target_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(approval_rows_before, 0);

    let approve_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/volunteers/{target_id}/approve"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(approve_response.status(), StatusCode::NO_CONTENT);

    let approval_rows_after: i64 = sqlx::query_scalar(approval_audit_query)
        .bind(target_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(
        approval_rows_after, 1,
        "admin approval must write exactly one audit_log entry for this mutation"
    );

    let status: String = sqlx::query_scalar("select status from volunteer where id = $1")
        .bind(target_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(status, "approved");
}

