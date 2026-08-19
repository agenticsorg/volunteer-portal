//! Prompt 2.2 exit criterion (ADR-0007): an integration test proves that
//! an attacker controlling a same-email account on a second provider
//! **cannot** merge into a victim's account without first being
//! authenticated as the victim.

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use projects_assignments::SqlxProjectRepository;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
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

struct FakeGoogleOAuthClient {
    user: GoogleUserInfo,
}

#[async_trait::async_trait]
impl GoogleOAuthClient for FakeGoogleOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce) {
        (
            "https://accounts.google.com/o/oauth2/v2/auth?fake=1".parse().unwrap(),
            CsrfToken::new("fake-google-csrf".to_string()),
            Nonce::new("fake-nonce".to_string()),
        )
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
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
    google_user: GoogleUserInfo,
) -> axum::Router {
    let session_store = PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = api::session::configure(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        discord_oauth: Arc::new(FakeDiscordOAuthClient { user: discord_user }),
        google_oauth: Some(Arc::new(FakeGoogleOAuthClient { user: google_user })),
    };

    api::build_router(state).layer(session_layer)
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

#[tokio::test]
async fn attacker_cannot_merge_into_victim_account_via_matching_email() {
    let (_container, owner_pool, app_pool) = setup().await;

    // The victim already has a Discord-verified account with this email.
    let victim_discord = DiscordUserInfo {
        id: "victim-discord-id".to_string(),
        username: "victim".to_string(),
        email: Some("shared@example.org".to_string()),
        verified: true,
    };
    // The "attacker" controls a Google account claiming the same,
    // verified email (e.g. because the attacker actually owns that
    // Google inbox too, or is spoofing a verified claim) — the point of
    // this test is that verification of the *second* login's own claim
    // is irrelevant; what matters is the *existing* identity is verified
    // and the attacker has no session as the victim.
    let attacker_google = GoogleUserInfo {
        subject: "attacker-google-subject".to_string(),
        email: Some("shared@example.org".to_string()),
        email_verified: true,
        name: Some("Attacker".to_string()),
    };

    let app = build_test_app(&owner_pool, app_pool, victim_discord, attacker_google).await;

    // Victim signs up for real via Discord first.
    let signup = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/login")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let signup_cookie = first_cookie_pair(signup.headers().get("set-cookie").unwrap().to_str().unwrap());
    app.clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/callback?code=x&state=fake-discord-csrf")
                .header("cookie", &signup_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let victim_id: uuid::Uuid =
        sqlx::query_scalar("select id from volunteer where discord_id = 'victim-discord-id'")
            .fetch_one(&owner_pool)
            .await
            .unwrap();

    // The attacker, with NO session (never authenticated as the victim),
    // attempts to log in via Google using the victim's email.
    let attacker_login = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/google/login")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let attacker_cookie =
        first_cookie_pair(attacker_login.headers().get("set-cookie").unwrap().to_str().unwrap());

    let attacker_callback = app
        .oneshot(
            Request::builder()
                .uri("/auth/google/callback?code=y&state=fake-google-csrf")
                .header("cookie", &attacker_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Refused — not silently merged, not silently logged in as a new
    // account either.
    assert_eq!(attacker_callback.status(), StatusCode::CONFLICT);

    // The victim's account is completely untouched: still exactly one
    // OAuth identity (Discord), no Google link was attached.
    let identity_count: i64 = sqlx::query_scalar(
        "select count(*) from identity where volunteer_id = $1",
    )
    .bind(victim_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(identity_count, 1);

    // No new volunteer was created for the attacker's Google identity
    // either — the attempt was refused outright, not given a fresh
    // account as a fallback.
    let google_identity_count: i64 = sqlx::query_scalar(
        "select count(*) from identity where provider = 'google' and provider_user_id = 'attacker-google-subject'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(google_identity_count, 0);
}

#[tokio::test]
async fn legitimate_owner_can_link_a_second_provider_from_an_authenticated_session() {
    let (_container, owner_pool, app_pool) = setup().await;

    let owner_discord = DiscordUserInfo {
        id: "owner-discord-id".to_string(),
        username: "owner".to_string(),
        email: Some("owner@example.org".to_string()),
        verified: true,
    };
    let owner_google = GoogleUserInfo {
        subject: "owner-google-subject".to_string(),
        email: Some("owner@example.org".to_string()),
        email_verified: true,
        name: Some("Owner".to_string()),
    };

    let app = build_test_app(&owner_pool, app_pool, owner_discord, owner_google).await;

    // Owner logs in via Discord.
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/login")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let login_cookie = first_cookie_pair(login.headers().get("set-cookie").unwrap().to_str().unwrap());
    let login_callback = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/callback?code=x&state=fake-discord-csrf")
                .header("cookie", &login_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let session_cookie = first_cookie_pair(
        login_callback
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );

    let owner_id: uuid::Uuid =
        sqlx::query_scalar("select id from volunteer where discord_id = 'owner-discord-id'")
            .fetch_one(&owner_pool)
            .await
            .unwrap();

    // Still authenticated as themselves, they explicitly initiate
    // linking Google.
    let link_start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/google/link")
                .header("cookie", &session_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(link_start.status(), StatusCode::SEE_OTHER);
    let link_cookie =
        first_cookie_pair(link_start.headers().get("set-cookie").unwrap().to_str().unwrap());

    let link_callback = app
        .oneshot(
            Request::builder()
                .uri("/auth/google/callback?code=y&state=fake-google-csrf")
                .header("cookie", &link_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(link_callback.status(), StatusCode::SEE_OTHER);

    let identity_count: i64 =
        sqlx::query_scalar("select count(*) from identity where volunteer_id = $1")
            .bind(owner_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(identity_count, 2, "both Discord and Google identities should now be linked to the one account");
}
