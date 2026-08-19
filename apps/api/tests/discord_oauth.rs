//! Prompt 1.5 exit criterion: a Discord OAuth login round-trip completes
//! and results in a session cookie scoped correctly for the chosen
//! subdomain architecture (ADR-0012).
//!
//! No Discord OAuth app credentials are available in this environment
//! (see the project's running pending-credentials list). This test
//! exercises the *real* handler logic (`api::routes::discord_login`/
//! `discord_callback`, session CSRF/PKCE handling, volunteer
//! lookup-or-signup, audit wiring, session cookie issuance) end-to-end
//! against a `FakeDiscordOAuthClient` standing in for Discord's actual
//! token/user-info endpoints — everything up to that external boundary
//! is real and tested; only the literal "against a real Discord app in a
//! dev guild" sub-criterion is blocked on credentials, not attempted to
//! fake.

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, OAuthError};
use api::state::AppState;
use projects_assignments::SqlxProjectRepository;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use oauth2::{CsrfToken, PkceCodeVerifier};
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;
use tower_sessions_sqlx_store_chrono::PostgresStore;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

struct FakeDiscordOAuthClient {
    user: DiscordUserInfo,
}

#[async_trait::async_trait]
impl DiscordOAuthClient for FakeDiscordOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, PkceCodeVerifier) {
        (
            "https://discord.com/api/oauth2/authorize?fake=1"
                .parse()
                .unwrap(),
            CsrfToken::new("fake-csrf-token".to_string()),
            PkceCodeVerifier::new("fake-pkce-verifier".to_string()),
        )
    }

    async fn exchange_code(
        &self,
        _code: String,
        _pkce_verifier: PkceCodeVerifier,
    ) -> Result<String, OAuthError> {
        Ok("fake-access-token".to_string())
    }

    async fn fetch_user(&self, _access_token: &str) -> Result<DiscordUserInfo, OAuthError> {
        Ok(self.user.clone())
    }
}

fn first_cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

async fn build_test_app(
    owner_pool: &PgPool,
    app_pool: PgPool,
    discord_user: DiscordUserInfo,
) -> axum::Router {
    let session_store = PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = api::session::configure(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        discord_oauth: Arc::new(FakeDiscordOAuthClient { user: discord_user }),
        google_oauth: None,
    };

    api::build_router(state).layer(session_layer)
}

#[tokio::test]
async fn discord_login_redirects_to_authorize_url_and_sets_session_cookie() {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "discord-123".to_string(),
            username: "newvolunteer".to_string(),
            email: Some("newvolunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/auth/discord/login")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = response.headers().get("location").unwrap().to_str().unwrap();
    assert!(location.starts_with("https://discord.com/api/oauth2/authorize"));

    let set_cookie = response.headers().get("set-cookie").unwrap().to_str().unwrap();
    // ADR-0012 cookie scoping: HttpOnly, SameSite=Lax (not Strict — the
    // OAuth callback is a cross-site top-level navigation), Secure by
    // default.
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(set_cookie.contains("Secure"));
}

#[tokio::test]
async fn discord_callback_completes_round_trip_for_a_new_volunteer() {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "discord-456".to_string(),
            username: "roundtrip".to_string(),
            email: Some("roundtrip@example.org".to_string()),
            verified: true,
        },
    )
    .await;

    // Step 1: hit /login, capture the session cookie (holds the CSRF
    // state + PKCE verifier the fake client returns deterministically).
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
    let cookie = first_cookie_pair(
        login_response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );

    // Step 2: simulate Discord's redirect back to our callback with the
    // matching state (the fake client always issues "fake-csrf-token").
    let callback_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/callback?code=fake-code&state=fake-csrf-token")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(callback_response.status(), StatusCode::SEE_OTHER);
    let callback_set_cookie = callback_response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(callback_set_cookie.contains("HttpOnly"));
    assert!(callback_set_cookie.contains("SameSite=Lax"));

    // The round trip created exactly one new volunteer, linked to the
    // Discord identity the fake client reported.
    let volunteer_count: i64 = sqlx::query_scalar(
        "select count(*) from volunteer where discord_id = 'discord-456'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(volunteer_count, 1);

    let audit_count: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'created' and entity_type = 'volunteer'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);
}

#[tokio::test]
async fn returning_volunteer_logs_in_without_creating_a_duplicate() {
    // Regression test: the pre-auth identity lookup
    // (VolunteerRepository::find_by_oauth_identity) is necessarily run
    // under an arbitrary "probe" actor's RLS scope, since the caller
    // isn't authenticated as anyone yet. An earlier version of this
    // lookup fetched the full Volunteer row on that same probe-scoped
    // transaction, which RLS silently filtered to None for any actor
    // other than the target volunteer -- making every *second* login
    // attempt fall through to signup, hit the unique email/discord_id
    // constraint, and 500. Fixed by returning only the id from the
    // SECURITY DEFINER-backed lookup and loading the full aggregate (if
    // ever needed) from a fresh transaction scoped as that id.
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "discord-returning".to_string(),
            username: "returning".to_string(),
            email: Some("returning@example.org".to_string()),
            verified: true,
        },
    )
    .await;

    for _ in 0..2 {
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
        let cookie = first_cookie_pair(
            login_response
                .headers()
                .get("set-cookie")
                .unwrap()
                .to_str()
                .unwrap(),
        );
        let callback_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/discord/callback?code=fake-code&state=fake-csrf-token")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(callback_response.status(), StatusCode::SEE_OTHER);
    }

    let volunteer_count: i64 = sqlx::query_scalar(
        "select count(*) from volunteer where discord_id = 'discord-returning'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        volunteer_count, 1,
        "a second login for the same Discord identity must not create a duplicate volunteer"
    );
}

#[tokio::test]
async fn discord_callback_rejects_mismatched_csrf_state() {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let app = build_test_app(
        &owner_pool,
        app_pool,
        DiscordUserInfo {
            id: "discord-789".to_string(),
            username: "attacker-target".to_string(),
            email: Some("x@example.org".to_string()),
            verified: true,
        },
    )
    .await;

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
    let cookie = first_cookie_pair(
        login_response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );

    let callback_response = app
        .oneshot(
            Request::builder()
                .uri("/auth/discord/callback?code=fake-code&state=wrong-state")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(callback_response.status(), StatusCode::UNAUTHORIZED);

    let volunteer_count: i64 =
        sqlx::query_scalar("select count(*) from volunteer where discord_id = 'discord-789'")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(volunteer_count, 0);
}
