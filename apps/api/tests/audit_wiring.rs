//! Prompt 1.4 exit criterion: a handler that mutates `Volunteer` (via
//! Prompt 1.3's `VolunteerRepository`) and returns an `AuditableEvent`
//! produces exactly one `audit_log` row per mutation, with no code
//! outside the framework helper (`kernel::record_audit_events`) touching
//! `audit_log`.
//!
//! This exercises the same `AuthUser` extractor and `AppState` the real
//! composition root (`api::build_router`) uses, via a small test-only
//! router — the real domain routes (signup, approvals, ...) are added in
//! later prompts as each context's handlers are built.

use std::sync::Arc;

use api::auth::{AuthUser, SESSION_VOLUNTEER_ID_KEY};
use api::oauth::{DiscordOAuthClient, DiscordUserInfo, OAuthError};
use api::state::AppState;
use projects_assignments::SqlxProjectRepository;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use identity_access::{
    Agreements, Availability, OAuthProvider, Role, SqlxVolunteerRepository, Volunteer,
    VolunteerRepository,
};
use kernel::Id;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;
use tower_sessions::{Session, SessionManagerLayer};
use tower_sessions_sqlx_store_chrono::PostgresStore;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

/// Test-only handler: sets the caller's session, standing in for a real
/// login flow (built in Prompt 1.5). Not part of the real API surface.
async fn test_login(session: Session, Path(volunteer_id): Path<Uuid>) -> impl IntoResponse {
    session
        .insert(SESSION_VOLUNTEER_ID_KEY, volunteer_id)
        .await
        .unwrap();
    StatusCode::OK
}

/// Test-only handler exercising the exact wiring Prompt 1.4 must prove:
/// AuthUser-gated, mutates a Volunteer via the repository, and records
/// audit events through the framework helper — nothing else touches
/// audit_log.
async fn test_approve(
    AuthUser(admin_id): AuthUser,
    State(state): State<AppState>,
    Path(target_id): Path<Uuid>,
) -> impl IntoResponse {
    let target_id = Id::from_uuid(target_id);
    let repo = SqlxVolunteerRepository;

    let mut tx = state.db.begin_scoped(admin_id.as_uuid()).await.unwrap();
    let mut volunteer = repo.find_by_id(&mut tx, target_id).await.unwrap().unwrap();
    volunteer.record_agreements(Agreements {
        code_of_conduct_accepted_at: Some(chrono::Utc::now()),
        ip_agreement_accepted_at: Some(chrono::Utc::now()),
        age_attestation_confirmed_at: Some(chrono::Utc::now()),
    });
    volunteer.approve(admin_id).unwrap();
    let events = repo.save(&mut tx, &mut volunteer).await.unwrap();
    let written = kernel::record_audit_events(&mut tx, &events).await.unwrap();
    tx.commit().await.unwrap();

    (StatusCode::OK, written.to_string())
}

/// This test suite never exercises OAuth routes — every method here
/// would only be reached by a bug in routing.
struct UnusedDiscordOAuthClient;

#[async_trait::async_trait]
impl DiscordOAuthClient for UnusedDiscordOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, oauth2::CsrfToken, oauth2::PkceCodeVerifier) {
        unimplemented!("not exercised by the audit-wiring test suite")
    }
    async fn exchange_code(
        &self,
        _code: String,
        _pkce_verifier: oauth2::PkceCodeVerifier,
    ) -> Result<String, OAuthError> {
        unimplemented!("not exercised by the audit-wiring test suite")
    }
    async fn fetch_user(&self, _access_token: &str) -> Result<DiscordUserInfo, OAuthError> {
        unimplemented!("not exercised by the audit-wiring test suite")
    }
}

fn first_cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn audit_framework_records_exactly_one_row_per_mutation() {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();

    let session_store = PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = SessionManagerLayer::new(session_store);

    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        discord_interactions_public_key: "test-public-key".to_string(),
        discord_oauth: Arc::new(UnusedDiscordOAuthClient),
        google_oauth: None,
    };

    let router = Router::new()
        .route("/test/login/{volunteer_id}", post(test_login))
        .route("/test/approve/{target_id}", post(test_approve))
        .with_state(state)
        .layer(session_layer);

    // Seed an admin (whose id is used only as the session identity/actor —
    // no admin-role check exists yet, that's Phase 3+) and a
    // pending-approval target volunteer, directly via the repository
    // against the owner connection (bypassing RLS/HTTP entirely, this is
    // fixture setup, not the thing under test).
    let admin = Volunteer::signup(
        "Admin".to_string(),
        "admin@example.org".to_string(),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        OAuthProvider::Discord,
        "discord-admin".to_string(),
        "admin@example.org".to_string(),
        true,
    )
    .unwrap();
    let admin_id = admin.id();

    let target = Volunteer::signup(
        "New Volunteer".to_string(),
        "newvol@example.org".to_string(),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        OAuthProvider::Discord,
        "discord-newvol".to_string(),
        "newvol@example.org".to_string(),
        true,
    )
    .unwrap();
    let target_id = target.id();

    {
        let db = kernel::ScopedDb::new(owner_pool.clone());
        let repo = SqlxVolunteerRepository;
        let mut admin = admin;
        admin.change_role(Role::Admin, admin_id).unwrap();
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        repo.save(&mut tx, &mut admin).await.unwrap();
        tx.commit().await.unwrap();

        let mut target = target;
        let mut tx = db.begin_scoped(target_id.as_uuid()).await.unwrap();
        repo.save(&mut tx, &mut target).await.unwrap();
        tx.commit().await.unwrap();
    }

    // "Log in" as admin: establishes a session cookie.
    let login_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/test/login/{admin_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login_response.status(), StatusCode::OK);
    let cookie = first_cookie_pair(
        login_response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );

    // The mutation under test: AuthUser-gated, repository-backed, audit
    // wired through the framework helper only.
    let approve_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/test/approve/{target_id}"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(approve_response.status(), StatusCode::OK);

    let audit_count: i64 = sqlx::query_scalar("select count(*) from audit_log")
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(
        audit_count, 1,
        "exactly one audit_log row must be produced by this one mutation"
    );

    let (action, entity_type, entity_id): (String, String, Uuid) =
        sqlx::query_as("select action, entity_type, entity_id from audit_log")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(action, "updated");
    assert_eq!(entity_type, "volunteer");
    assert_eq!(entity_id, target_id.as_uuid());
}

#[tokio::test]
async fn unauthenticated_request_is_rejected_before_any_mutation() {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();

    let session_store = PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = SessionManagerLayer::new(session_store);

    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        discord_interactions_public_key: "test-public-key".to_string(),
        discord_oauth: Arc::new(UnusedDiscordOAuthClient),
        google_oauth: None,
    };

    let router = Router::new()
        .route("/test/approve/{target_id}", post(test_approve))
        .with_state(state)
        .layer(session_layer);

    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/test/approve/{}", Uuid::new_v4()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let audit_count: i64 = sqlx::query_scalar("select count(*) from audit_log")
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(audit_count, 0);
}
