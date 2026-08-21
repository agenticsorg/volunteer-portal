//! `apps/api`'s composition root: Axum router, auth extractors
//! (ADR-0002), Discord/Google OAuth login and account linking
//! (ADR-0007), onboarding and admin approval (Prompt 2.3), project
//! directory/apply/roster management (Prompt 3.3), and the
//! framework-level audit wiring (ADR-0005). Exposed as a library (in
//! addition to `main.rs`'s binary) so integration tests can build the
//! same `Router`/`AppState` without spawning a real server.

pub mod account_linking;
pub mod active_membership_adapter;
pub mod admin_reporting;
pub mod assignment_recipient_adapter;
pub mod assignment_snapshot_adapter;
pub mod auth;
pub mod discord_dm_adapter;
pub mod discord_interactions;
pub mod dto;
pub mod email_templates;
pub mod error;
pub mod hour_entry_recipient_adapter;
pub mod hours;
pub mod oauth;
pub mod onboarding;
pub mod postmark_email_provider;
pub mod project_name_adapter;
pub mod projects;
pub mod resend_email_provider;
pub mod routes;
pub mod semantic_matching;
pub mod semantic_matching_client;
pub mod session;
pub mod state;
pub mod verification_letter;
pub mod verification_letter_render;

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
        .route(
            "/projects/{project_id}/hours/total",
            get(hours::project_hours_total),
        )
        .route("/assignments/{assignment_id}/hours", post(hours::log_hours))
        .route("/hours/pending", get(hours::list_pending_hours))
        .route("/hours/approve", post(hours::bulk_approve_hours))
        .route("/hours/{hour_entry_id}/reject", post(hours::reject_hours))
        .route(
            "/admin/hours/{hour_entry_id}/adjust",
            post(hours::adjust_hours),
        )
        .route(
            "/volunteers/{volunteer_id}/hours/total",
            get(hours::volunteer_hours_total),
        )
        .route(
            "/volunteers/{volunteer_id}/verification-letter",
            get(verification_letter::generate_verification_letter),
        )
        .route("/admin/volunteers", get(admin_reporting::list_volunteer_roster))
        .route(
            "/admin/volunteers/export.csv",
            get(admin_reporting::export_volunteer_roster_csv),
        )
        .route("/admin/reports/hours", get(admin_reporting::hours_report))
        .route("/projects/suggest", get(semantic_matching::suggest_projects))
        .route(
            "/volunteers/me/hours-suggestions",
            get(semantic_matching::hours_suggestions),
        )
        .route(
            "/discord/interactions",
            post(discord_interactions::handle_interaction),
        )
        .with_state(state)
}
