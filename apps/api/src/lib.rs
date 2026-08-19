//! `apps/api`'s composition root: Axum router, auth extractors
//! (ADR-0002), Discord/Google OAuth login and account linking
//! (ADR-0007), onboarding and admin approval (Prompt 2.3), project
//! directory/apply/roster management (Prompt 3.3), and the
//! framework-level audit wiring (ADR-0005). Exposed as a library (in
//! addition to `main.rs`'s binary) so integration tests can build the
//! same `Router`/`AppState` without spawning a real server.

pub mod account_linking;
pub mod auth;
pub mod dto;
pub mod error;
pub mod oauth;
pub mod onboarding;
pub mod projects;
pub mod routes;
pub mod session;
pub mod state;

use axum::routing::{get, post};
use axum::Router;

use state::AppState;

async fn health() -> &'static str {
    "ok"
}

/// The composition root. Full domain-route wiring beyond auth/onboarding/
/// projects (hours endpoints, etc.) is added by later prompts as each
/// context's handlers are built.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/auth/discord/login", get(routes::discord_login))
        .route("/auth/discord/link", get(routes::discord_link))
        .route("/auth/discord/callback", get(routes::discord_callback))
        .route("/auth/google/login", get(routes::google_login))
        .route("/auth/google/link", get(routes::google_link))
        .route("/auth/google/callback", get(routes::google_callback))
        .route("/auth/me", get(routes::me))
        .route(
            "/volunteers/me/onboarding",
            post(onboarding::complete_onboarding),
        )
        .route(
            "/admin/volunteers/{id}/approve",
            post(onboarding::approve_volunteer),
        )
        .route(
            "/projects",
            get(projects::list_open_projects).post(projects::create_project),
        )
        .route("/projects/{project_id}/apply", post(projects::apply_to_project))
        .route("/projects/{project_id}/roster", get(projects::get_roster))
        .route(
            "/projects/{project_id}/assignments/approve",
            post(projects::approve_assignment),
        )
        .route(
            "/projects/{project_id}/assignments/remove",
            post(projects::remove_assignment),
        )
        .with_state(state)
}
