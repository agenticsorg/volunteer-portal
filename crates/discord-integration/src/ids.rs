use std::fmt;

/// Discord snowflakes are represented as `String` throughout this
/// codebase (matching `identity-access`'s existing `discord_id: Option<String>`
/// on `Volunteer` and the `volunteer.discord_id text` column), not `u64`
/// -- one representation, no conversion at the identity-access boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DiscordUserId(pub String);

impl fmt::Display for DiscordUserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The ACL's *output* vocabulary (discord-integration.md): still not a
/// `twilight_model` type, so a future Discord HTTP client swap touches
/// only `infra`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DiscordRoleId(pub String);

impl fmt::Display for DiscordRoleId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
