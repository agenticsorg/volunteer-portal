use std::sync::Arc;

use hours_verification::AssignmentSnapshotQuery;
use kernel::ScopedDb;
use projects_assignments::LeadMembershipQuery;

#[derive(Clone)]
pub struct AppState {
    pub db: ScopedDb,
    /// `projects-assignments`'s real `project_lead`-table-backed
    /// implementation (`SqlxProjectRepository`), wired in Prompt 3.1 --
    /// replaces Prompt 1.4's local `StubLeadMembershipQuery` stub, which
    /// is deleted along with this file's former local trait definition.
    pub lead_membership: Arc<dyn LeadMembershipQuery>,
    /// `hours-verification`'s read port onto the shared `assignment`
    /// table (Prompt 4.1) -- used both by `HourEntry::log`'s caller and
    /// by bulk-approve to resolve each entry's `project_id` for the
    /// per-entry `LeadMembershipQuery` re-check (hours-verification.md's
    /// "Other invariants").
    pub assignment_snapshot: Arc<dyn AssignmentSnapshotQuery>,
    pub discord_oauth: Arc<dyn crate::oauth::DiscordOAuthClient>,
    /// `None` when Google OAuth credentials aren't configured (e.g. no
    /// live Google app in this environment) — the Google routes 404
    /// rather than panicking at startup, per the project's stated
    /// approach to missing external credentials. Discord has no
    /// equivalent `Option` because it's the mandatory primary provider
    /// (concept.md: "Discord primary, Google fallback").
    pub google_oauth: Option<Arc<dyn crate::oauth::GoogleOAuthClient>>,
}
