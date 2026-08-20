//! Discord Integration bounded context (ACL). See `.plans/ddd/discord-integration.md`.
//! Implemented in Prompts 5.1-5.2. Depends on `kernel` and
//! `identity-access` only (context-map.md) -- never `projects-assignments`,
//! whose `ActiveProjectMembershipQuery` implementation is wired at the
//! `apps/api` composition root instead.

mod discord_client;
mod discord_role_mapping;
mod events;
mod ids;
mod infra;
mod link_command;
mod mapping;
mod queries;
mod reconciler;
mod repository;
mod role;

pub use discord_client::{
    ActualMemberRoles, DiscordApiError, DiscordNotificationSender, DiscordRoleReadWrite,
    RoleChangeAction, RoleChangeOutcome, RoleDelta,
};
pub use discord_role_mapping::SqlxDiscordRoleMapping;
pub use events::DiscordRoleReconciled;
pub use ids::{DiscordRoleId, DiscordUserId};
pub use infra::TwilightDiscordClient;
pub use link_command::{LinkCommandHandler, LinkStatus};
pub use mapping::{DiscordRoleMapping, MappingError};
pub use queries::{
    ActiveProjectMembershipQuery, ApprovedVolunteersQuery, IdentityAccessApprovedVolunteersQuery,
};
pub use reconciler::{ReconcileError, ReconcileReport, RoleReconciler};
pub use repository::{ReconcileRunLogRepository, SqlxReconcileRunLogRepository};
pub use role::{DesiredRoleSet, VolunteerFacingRole};
