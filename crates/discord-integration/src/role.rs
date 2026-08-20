use kernel::{ProjectId, VolunteerId};

use crate::ids::DiscordUserId;

/// Internal, Discord-shape-free representation of "what role concept a
/// volunteer should hold" -- never a Discord role snowflake ID
/// (discord-integration.md's "The ACL boundary").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VolunteerFacingRole {
    BaseVolunteer,
    ProjectMember(ProjectId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesiredRoleSet {
    pub volunteer_id: VolunteerId,
    pub discord_id: DiscordUserId,
    pub roles: Vec<VolunteerFacingRole>,
}
