use std::sync::Arc;

use async_trait::async_trait;
use kernel::{ProjectId, RepoError, ScopedDb, VolunteerId};
use sqlx::{Postgres, Transaction};

/// Owned by `projects-assignments` per projects-assignments.md — this
/// crate doesn't exist yet (built in Prompt 3.1/3.2). Per Prompt 1.4's
/// explicit instruction, this port is **stubbed here** so the `LeadOf`
/// extractor can exist and be lint-enforced from the first handler
/// onward; Prompt 3.2 replaces `StubLeadMembershipQuery` with the real
/// `project_lead`-table-backed implementation and this local trait
/// definition is deleted in favor of importing `projects-assignments`'s.
#[async_trait]
pub trait LeadMembershipQuery: Send + Sync {
    async fn is_lead_of_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
        project_id: ProjectId,
    ) -> Result<bool, RepoError>;
}

/// Default-deny: until Prompt 3.2 wires the real `project_lead`-backed
/// query, no one is ever recognized as a lead of anything.
pub struct StubLeadMembershipQuery;

#[async_trait]
impl LeadMembershipQuery for StubLeadMembershipQuery {
    async fn is_lead_of_project(
        &self,
        _tx: &mut Transaction<'_, Postgres>,
        _volunteer_id: VolunteerId,
        _project_id: ProjectId,
    ) -> Result<bool, RepoError> {
        Ok(false)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: ScopedDb,
    pub lead_membership: Arc<dyn LeadMembershipQuery>,
    pub discord_oauth: Arc<dyn crate::oauth::DiscordOAuthClient>,
    /// `None` when Google OAuth credentials aren't configured (e.g. no
    /// live Google app in this environment) — the Google routes 404
    /// rather than panicking at startup, per the project's stated
    /// approach to missing external credentials. Discord has no
    /// equivalent `Option` because it's the mandatory primary provider
    /// (concept.md: "Discord primary, Google fallback").
    pub google_oauth: Option<Arc<dyn crate::oauth::GoogleOAuthClient>>,
}
