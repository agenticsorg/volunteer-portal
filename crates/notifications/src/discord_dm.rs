use async_trait::async_trait;

/// Plain-text DM body -- Discord DMs aren't HTML-templated the way email
/// is (concept.md section 6 describes them as simple "notifications to
/// DM or channel", not a branded document).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmContent(pub String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Discord DM delivery failed: {0}")]
pub struct DiscordDeliveryError(pub String);

/// Delivery mechanics only -- **what** to say and **when** belongs to
/// this crate; **how** to actually call Discord's REST API belongs to
/// `discord-integration` (its own `DiscordNotificationSender`, Prompt
/// 5.1). `discord-integration` and `notifications` are siblings
/// (context-map.md's acyclic dependency graph), so an `apps/api` adapter
/// bridges the two, the same shape as
/// `hours_verification::AssignmentSnapshotQuery`. Not called by this
/// crate's v1 dispatch flow (every trigger sends `Email` in v1, per
/// `TriggerType`'s doc comment) -- defined and wired now so the port
/// shape is settled and testable ahead of a later phase actually
/// exercising it.
#[async_trait]
pub trait DiscordDmSender: Send + Sync {
    async fn send_dm(&self, discord_user_id: &str, message: DmContent) -> Result<(), DiscordDeliveryError>;
}
