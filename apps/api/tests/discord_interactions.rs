//! Prompt 5.2 exit criteria: the `/discord/interactions` endpoint
//! verifies the request signature before parsing the payload (a request
//! with an invalid signature never reaches `/link`'s logic at all), PING
//! interactions get a PONG, and `/link` replies correctly for both the
//! already-linked and not-yet-linked cases -- driven through the real
//! Axum router (`api::build_router`), not a bare unit call, so this
//! proves the full HTTP wiring: header extraction, signature
//! verification, JSON parsing, `LinkCommandHandler`'s System-actor-scoped
//! DB read, and the interaction-response shape.
//!
//! End-to-end verification against a real Discord application (a live
//! bot, real Discord-issued signatures) is blocked on credentials -- no
//! Discord bot token or interactions public key is configured in this
//! environment. This test uses a self-generated Ed25519 keypair standing
//! in for Discord's own, the same approach `discord_interactions.rs`'s
//! own unit tests use, since Discord doesn't publish fixed test vectors
//! for the signature construction itself.

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::{Signer, SigningKey};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use projects_assignments::SqlxProjectRepository;
use serde_json::{json, Value};
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

struct UnusedDiscordOAuthClient;
#[async_trait::async_trait]
impl DiscordOAuthClient for UnusedDiscordOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, PkceCodeVerifier) {
        unimplemented!("not exercised by the discord_interactions test suite")
    }
    async fn exchange_code(&self, _code: String, _pkce: PkceCodeVerifier) -> Result<String, OAuthError> {
        unimplemented!("not exercised by the discord_interactions test suite")
    }
    async fn fetch_user(&self, _access_token: &str) -> Result<DiscordUserInfo, OAuthError> {
        unimplemented!("not exercised by the discord_interactions test suite")
    }
}

struct UnusedGoogleOAuthClient;
#[async_trait::async_trait]
impl GoogleOAuthClient for UnusedGoogleOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce) {
        unimplemented!("not exercised by the discord_interactions test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the discord_interactions test suite")
    }
}

fn test_key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn sign(signing_key: &SigningKey, timestamp: &str, body: &[u8]) -> String {
    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    hex::encode(signing_key.sign(&message).to_bytes())
}

async fn setup() -> (
    testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    axum::Router,
    PgPool,
) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    let public_key_hex = hex::encode(test_key().verifying_key().to_bytes());

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        project_names: Arc::new(api::project_name_adapter::ProjectsAssignmentsNameAdapter),
        semantic_match: Arc::new(api::semantic_matching_client::NullSemanticMatchClient),
        discord_interactions_public_key: public_key_hex,
        discord_oauth: Arc::new(UnusedDiscordOAuthClient),
        google_oauth: Some(Arc::new(UnusedGoogleOAuthClient)),
    };

    let router = api::build_router(state);
    (container, router, owner_pool)
}

async fn post_interaction(router: &axum::Router, body: &Value, timestamp: &str, signature: &str) -> axum::http::Response<Body> {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/discord/interactions")
                .header("content-type", "application/json")
                .header("x-signature-ed25519", signature)
                .header("x-signature-timestamp", timestamp)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn rejects_a_request_with_an_invalid_signature_before_reaching_link_logic() {
    let (_container, router, _owner_pool) = setup().await;

    let body = json!({ "type": 1 });
    let response = post_interaction(&router, &body, "1700000000", "not-a-real-signature").await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ping_gets_a_pong() {
    let (_container, router, _owner_pool) = setup().await;
    let signing_key = test_key();

    let body = json!({ "type": 1 });
    let timestamp = "1700000000";
    let signature = sign(&signing_key, timestamp, body.to_string().as_bytes());

    let response = post_interaction(&router, &body, timestamp, &signature).await;
    assert_eq!(response.status(), StatusCode::OK);

    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json_body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json_body["type"], 1);
}

#[tokio::test]
async fn link_command_tells_an_unlinked_discord_user_to_use_the_web_flow() {
    let (_container, router, _owner_pool) = setup().await;
    let signing_key = test_key();

    let body = json!({
        "type": 2,
        "data": { "name": "link" },
        "member": { "user": { "id": "999999" } },
    });
    let timestamp = "1700000000";
    let signature = sign(&signing_key, timestamp, body.to_string().as_bytes());

    let response = post_interaction(&router, &body, timestamp, &signature).await;
    assert_eq!(response.status(), StatusCode::OK);

    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json_body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json_body["type"], 4);
    let content = json_body["data"]["content"].as_str().unwrap();
    assert!(content.contains("Not linked"), "unexpected reply: {content}");
    assert_eq!(json_body["data"]["flags"], 64, "reply must be ephemeral");
}

#[tokio::test]
async fn link_command_tells_an_already_linked_discord_user_they_are_connected() {
    let (_container, router, owner_pool) = setup().await;
    let signing_key = test_key();

    sqlx::query(
        "insert into volunteer (name, email, timezone, role, status, discord_id) \
         values ('Linked Volunteer', 'linked@example.org', 'UTC', 'volunteer', 'approved', '888888')",
    )
    .execute(&owner_pool)
    .await
    .unwrap();

    let body = json!({
        "type": 2,
        "data": { "name": "link" },
        "member": { "user": { "id": "888888" } },
    });
    let timestamp = "1700000000";
    let signature = sign(&signing_key, timestamp, body.to_string().as_bytes());

    let response = post_interaction(&router, &body, timestamp, &signature).await;
    assert_eq!(response.status(), StatusCode::OK);

    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json_body: Value = serde_json::from_slice(&bytes).unwrap();
    let content = json_body["data"]["content"].as_str().unwrap();
    assert!(content.contains("already connected"), "unexpected reply: {content}");
}
