use async_trait::async_trait;

use crate::ids::{DiscordRoleId, DiscordUserId};

/// Live snapshot of one guild member's actual role assignments -- every
/// role the member currently has, not filtered to roles this system
/// manages. `RoleReconciler` (not this `infra` port) is responsible for
/// narrowing this down to only the managed role IDs before diffing, so a
/// human-assigned role this system doesn't manage (a "Moderator" badge,
/// say) is never a candidate for revocation. Fetched fresh on every
/// reconcile run, never cached -- discord-integration.md's
/// idempotency/self-healing guarantee depends on this being a live REST
/// read every time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActualMemberRoles {
    pub discord_id: DiscordUserId,
    pub role_ids: Vec<DiscordRoleId>,
}

/// One guild member's role changes to apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleDelta {
    pub discord_id: DiscordUserId,
    pub grant: Vec<DiscordRoleId>,
    pub revoke: Vec<DiscordRoleId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleChangeAction {
    Grant,
    Revoke,
}

/// One individual role change's outcome -- `apply_delta` is best-effort
/// per role change, not all-or-nothing (discord-integration.md's
/// "Failure handling": one failed grant/revoke doesn't abort the batch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleChangeOutcome {
    pub discord_id: DiscordUserId,
    pub role_id: DiscordRoleId,
    pub action: RoleChangeAction,
    pub error: Option<String>,
}

impl RoleChangeOutcome {
    pub fn is_success(&self) -> bool {
        self.error.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Discord API error: {0}")]
pub struct DiscordApiError(pub String);

/// The ACL's Discord-facing read/write port -- confined-to-`infra`
/// implementation only (discord-integration.md's ACL boundary rule: no
/// `twilight_model` type in this trait's signature).
#[async_trait]
pub trait DiscordRoleReadWrite: Send + Sync {
    async fn fetch_current_roles(&self) -> Result<Vec<ActualMemberRoles>, DiscordApiError>;

    async fn apply_delta(&self, deltas: &[RoleDelta]) -> Vec<RoleChangeOutcome>;
}

/// Delivery mechanics only -- **what** to say and **when** to trigger it
/// belongs to `notifications.md` (Prompt 7.1), which owns
/// `NotificationAttempt` bookkeeping and its own `DiscordDmSender` port
/// that an `apps/api` adapter will implement by delegating to this trait,
/// the same indirection `ActiveProjectMembershipQuery` uses today
/// (`discord-integration` and `notifications` are siblings -- neither
/// depends on the other). This crate's own `DiscordNotificationSender`
/// exists now because "implement the infra layer against twilight-http"
/// is this prompt's task regardless of which context ends up calling it.
#[async_trait]
pub trait DiscordNotificationSender: Send + Sync {
    async fn send_dm(&self, discord_id: &DiscordUserId, content: &str) -> Result<(), DiscordApiError>;
}
