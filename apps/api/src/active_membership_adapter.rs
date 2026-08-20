//! The concrete `discord_integration::ActiveProjectMembershipQuery`
//! implementation lives here, in the composition root, for the same
//! reason `assignment_snapshot_adapter.rs` does: `discord-integration`
//! cannot depend on `projects-assignments` (context-map.md's acyclic
//! dependency graph -- amended 2026-08-19 to cover this exact port too),
//! but `apps/api` already depends on both. Delegates to
//! `projects_assignments::ActiveContributorMembershipsQuery` (its own
//! SQL, already filtered to `Approved`/`Contributor` per Prompt 3.2's
//! `participation_mode` guarantee) -- no new SQL, no re-derivation of
//! event-hours logic.

use async_trait::async_trait;
use discord_integration::ActiveProjectMembershipQuery;
use kernel::{ProjectId, RepoError, VolunteerId};
use projects_assignments::{ActiveContributorMembershipsQuery, SqlxAssignmentRepository};
use sqlx::{Postgres, Transaction};

pub struct ProjectsAssignmentsActiveMembershipAdapter;

#[async_trait]
impl ActiveProjectMembershipQuery for ProjectsAssignmentsActiveMembershipAdapter {
    async fn active_contributor_memberships(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, ProjectId)>, RepoError> {
        SqlxAssignmentRepository.active_contributor_memberships(tx).await
    }
}
