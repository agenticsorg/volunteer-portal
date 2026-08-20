use async_trait::async_trait;
use twilight_http::Client;
use twilight_model::id::marker::{GuildMarker, RoleMarker, UserMarker};
use twilight_model::id::Id;

use crate::discord_client::{
    ActualMemberRoles, DiscordApiError, DiscordNotificationSender, DiscordRoleReadWrite,
    RoleChangeAction, RoleChangeOutcome, RoleDelta,
};
use crate::ids::{DiscordRoleId, DiscordUserId};

/// Discord paginates `guild_members` at up to 1000 per page.
const MEMBER_PAGE_LIMIT: u16 = 1000;

/// `twilight-http`-backed implementation of `DiscordRoleReadWrite`
/// (ADR-0008: `twilight-http`/`twilight-model`, not `serenity`; REST-only,
/// no persistent Gateway connection). This is the only file in the crate
/// permitted to import a `twilight_model`/`twilight_http` type.
pub struct TwilightDiscordClient {
    client: Client,
    guild_id: Id<GuildMarker>,
}

impl TwilightDiscordClient {
    pub fn new(bot_token: String, guild_id: u64) -> Self {
        Self {
            client: Client::new(bot_token),
            guild_id: Id::new(guild_id),
        }
    }

    async fn apply_one(
        &self,
        user_id: Id<UserMarker>,
        discord_id: &DiscordUserId,
        role_id: &DiscordRoleId,
        action: RoleChangeAction,
    ) -> RoleChangeOutcome {
        let Some(parsed_role_id) = role_id.0.parse::<u64>().ok().map(Id::<RoleMarker>::new) else {
            return RoleChangeOutcome {
                discord_id: discord_id.clone(),
                role_id: role_id.clone(),
                action,
                error: Some(format!("'{role_id}' is not a valid Discord role snowflake")),
            };
        };

        let result = match action {
            RoleChangeAction::Grant => self
                .client
                .add_guild_member_role(self.guild_id, user_id, parsed_role_id)
                .await
                .map(|_| ()),
            RoleChangeAction::Revoke => self
                .client
                .remove_guild_member_role(self.guild_id, user_id, parsed_role_id)
                .await
                .map(|_| ()),
        };

        RoleChangeOutcome {
            discord_id: discord_id.clone(),
            role_id: role_id.clone(),
            action,
            error: result.err().map(|e| e.to_string()),
        }
    }
}

#[async_trait]
impl DiscordRoleReadWrite for TwilightDiscordClient {
    async fn fetch_current_roles(&self) -> Result<Vec<ActualMemberRoles>, DiscordApiError> {
        let mut members = Vec::new();
        let mut after: Option<Id<UserMarker>> = None;

        loop {
            let mut request = self.client.guild_members(self.guild_id).limit(MEMBER_PAGE_LIMIT);
            if let Some(after_id) = after {
                request = request.after(after_id);
            }

            let page = request
                .await
                .map_err(|e| DiscordApiError(e.to_string()))?
                .models()
                .await
                .map_err(|e| DiscordApiError(e.to_string()))?;

            let is_last_page = page.len() < MEMBER_PAGE_LIMIT as usize;
            after = page.last().map(|m| m.user.id);

            members.extend(page.into_iter().map(|m| ActualMemberRoles {
                discord_id: DiscordUserId(m.user.id.to_string()),
                role_ids: m.roles.into_iter().map(|r| DiscordRoleId(r.to_string())).collect(),
            }));

            if is_last_page {
                break;
            }
        }

        Ok(members)
    }

    async fn apply_delta(&self, deltas: &[RoleDelta]) -> Vec<RoleChangeOutcome> {
        let mut outcomes = Vec::new();

        for delta in deltas {
            let Some(user_id) = delta.discord_id.0.parse::<u64>().ok().map(Id::<UserMarker>::new) else {
                // Every discord_id here originated from our own `volunteer`
                // table (identity-access's OAuth-confirmed discord_id) or
                // from Discord's own member list, so this is defensive,
                // not an expected path -- still reported per-change rather
                // than panicking, matching "best-effort, not all-or-nothing".
                for role_id in delta.grant.iter().chain(delta.revoke.iter()) {
                    outcomes.push(RoleChangeOutcome {
                        discord_id: delta.discord_id.clone(),
                        role_id: role_id.clone(),
                        action: RoleChangeAction::Grant,
                        error: Some(format!(
                            "'{}' is not a valid Discord user snowflake",
                            delta.discord_id
                        )),
                    });
                }
                continue;
            };

            for role_id in &delta.grant {
                outcomes.push(
                    self.apply_one(user_id, &delta.discord_id, role_id, RoleChangeAction::Grant)
                        .await,
                );
            }
            for role_id in &delta.revoke {
                outcomes.push(
                    self.apply_one(user_id, &delta.discord_id, role_id, RoleChangeAction::Revoke)
                        .await,
                );
            }
        }

        outcomes
    }
}

#[async_trait]
impl DiscordNotificationSender for TwilightDiscordClient {
    async fn send_dm(&self, discord_id: &DiscordUserId, content: &str) -> Result<(), DiscordApiError> {
        let user_id: Id<UserMarker> = discord_id
            .0
            .parse::<u64>()
            .map(Id::new)
            .map_err(|_| DiscordApiError(format!("'{discord_id}' is not a valid Discord user snowflake")))?;

        let channel = self
            .client
            .create_private_channel(user_id)
            .await
            .map_err(|e| DiscordApiError(e.to_string()))?
            .model()
            .await
            .map_err(|e| DiscordApiError(e.to_string()))?;

        self.client
            .create_message(channel.id)
            .content(content)
            .await
            .map_err(|e| DiscordApiError(e.to_string()))?;

        Ok(())
    }
}
