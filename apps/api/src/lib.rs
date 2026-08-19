//! `apps/api`'s composition root: Axum router, auth extractors
//! (ADR-0002), Discord OAuth login (ADR-0007), and the framework-level
//! audit wiring (ADR-0005). Exposed as a library (in addition to
//! `main.rs`'s binary) so integration tests can build the same
//! `Router`/`AppState` without spawning a real server.

pub mod auth;
pub mod error;
pub mod oauth;
pub mod routes;
pub mod session;
pub mod state;

use axum::routing::get;
use axum::Router;

use state::AppState;

async fn health() -> &'static str {
    "ok"
}

/// The composition root. Full domain-route wiring beyond auth (signup
/// form, project/hours endpoints, etc.) is added by later prompts as
/// each context's handlers are built.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/auth/discord/login", get(routes::discord_login))
        .route("/auth/discord/callback", get(routes::discord_callback))
        .with_state(state)
}
