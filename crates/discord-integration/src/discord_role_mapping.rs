use std::collections::HashMap;

use async_trait::async_trait;
use kernel::{Id, ProjectId, RepoError};
use sqlx::PgPool;

use crate::ids::DiscordRoleId;
use crate::mapping::{DiscordRoleMapping, MappingError};
use crate::role::VolunteerFacingRole;

/// Loads the `discord_role_mapping` config table once (via `load`), then
/// answers `resolve` calls from memory -- `DiscordRoleMapping::resolve`'s
/// signature (discord-integration.md) takes no transaction, matching the
/// "config" framing: this is guild-specific deploy/config data, not a
/// per-request-scoped query. Read with a bare (non-`begin_scoped`) pool
/// query, so `current_actor_id()` naturally resolves `NULL` and the
/// table's RLS `current_actor_id() is null` allowance (migration
/// 20260819000010) is satisfied without needing a `System`-actor
/// transaction wrapper here.
pub struct SqlxDiscordRoleMapping {
    base: Option<DiscordRoleId>,
    projects: HashMap<ProjectId, DiscordRoleId>,
}

impl SqlxDiscordRoleMapping {
    pub async fn load(pool: &PgPool) -> Result<Self, RepoError> {
        let rows = sqlx::query!(r#"select project_id, discord_role_id from discord_role_mapping"#)
            .fetch_all(pool)
            .await?;

        let mut base = None;
        let mut projects = HashMap::new();
        for row in rows {
            match row.project_id {
                None => base = Some(DiscordRoleId(row.discord_role_id)),
                Some(project_id) => {
                    projects.insert(Id::from_uuid(project_id), DiscordRoleId(row.discord_role_id));
                }
            }
        }

        Ok(Self { base, projects })
    }
}

#[async_trait]
impl DiscordRoleMapping for SqlxDiscordRoleMapping {
    async fn resolve(&self, role: &VolunteerFacingRole) -> Result<DiscordRoleId, MappingError> {
        match role {
            VolunteerFacingRole::BaseVolunteer => {
                self.base.clone().ok_or(MappingError::Unmapped(*role))
            }
            VolunteerFacingRole::ProjectMember(project_id) => self
                .projects
                .get(project_id)
                .cloned()
                .ok_or(MappingError::Unmapped(*role)),
        }
    }
}
