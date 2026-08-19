//! `apps/api`'s composition root: Axum router, auth extractors
//! (ADR-0002), and the framework-level audit wiring (ADR-0005). Exposed
//! as a library (in addition to `main.rs`'s binary) so integration tests
//! can build the same `Router`/`AppState` without spawning a real server.

pub mod auth;
pub mod error;
pub mod state;

use axum::routing::get;
use axum::Router;

use state::AppState;

async fn health() -> &'static str {
    "ok"
}

/// The composition root. Full domain-route wiring (signup, approvals,
/// etc.) is added by later prompts as each context's handlers are built;
/// this stays a health-check route only through Prompt 1.4, per Prompt
/// 1.1's original scope note.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state(state)
}
