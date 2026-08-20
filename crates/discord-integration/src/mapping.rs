use async_trait::async_trait;

use crate::ids::DiscordRoleId;
use crate::role::VolunteerFacingRole;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MappingError {
    #[error("no Discord role mapping configured for {0:?}")]
    Unmapped(VolunteerFacingRole),
}

/// Translates internal role concepts to concrete Discord role IDs for the
/// configured guild -- role IDs are guild-specific and only knowable at
/// deploy/config time, never hardcoded (discord-integration.md).
#[async_trait]
pub trait DiscordRoleMapping: Send + Sync {
    async fn resolve(&self, role: &VolunteerFacingRole) -> Result<DiscordRoleId, MappingError>;
}
