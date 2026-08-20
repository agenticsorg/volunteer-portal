use async_trait::async_trait;
use identity_access::VolunteerSummaryQuery;
use kernel::{ProjectId, RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::ids::DiscordUserId;

#[async_trait]
pub trait ApprovedVolunteersQuery: Send + Sync {
    /// Every volunteer with status == Approved and a linked discord_id.
    async fn approved_with_discord_link(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, DiscordUserId)>, RepoError>;
}

#[async_trait]
pub trait ActiveProjectMembershipQuery: Send + Sync {
    /// Every (volunteer, project) pair with an Approved Assignment whose
    /// participation_mode is Contributor.
    async fn active_contributor_memberships(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, ProjectId)>, RepoError>;
}

/// Concrete `ApprovedVolunteersQuery` implementation living directly in
/// this crate, not `apps/api` -- `discord-integration` IS a legal Cargo
/// dependent of `identity-access` (context-map.md: "Depends on `kernel`
/// and `identity-access`"), unlike `ActiveProjectMembershipQuery`, whose
/// implementation must live in `apps/api` because `projects-assignments`
/// is *not* a legal dependency here. Delegates to
/// `identity_access::VolunteerSummaryQuery::approved_with_discord_id` --
/// no duplicated SQL.
pub struct IdentityAccessApprovedVolunteersQuery<Q> {
    query: Q,
}

impl<Q: VolunteerSummaryQuery> IdentityAccessApprovedVolunteersQuery<Q> {
    pub fn new(query: Q) -> Self {
        Self { query }
    }
}

#[async_trait]
impl<Q: VolunteerSummaryQuery> ApprovedVolunteersQuery for IdentityAccessApprovedVolunteersQuery<Q> {
    async fn approved_with_discord_link(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, DiscordUserId)>, RepoError> {
        let rows = self.query.approved_with_discord_id(tx).await?;
        Ok(rows
            .into_iter()
            .map(|(id, discord_id)| (id, DiscordUserId(discord_id)))
            .collect())
    }
}
