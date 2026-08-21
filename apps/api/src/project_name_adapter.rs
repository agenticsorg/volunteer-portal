//! The concrete `hours_verification::ProjectNameQuery` implementation
//! lives here, in the composition root, for the same reason as
//! `assignment_snapshot_adapter.rs`: `hours-verification` cannot depend
//! on `projects-assignments` (context-map.md's acyclic dependency graph
//! places them as siblings), but `apps/api` already depends on both.
//! Delegates to `projects_assignments::SqlxProjectRepository::find_by_id`
//! and `Project::name()` -- no new SQL, single source of truth for a
//! project's display name stays in `projects-assignments`.

use async_trait::async_trait;
use hours_verification::ProjectNameQuery;
use kernel::{ProjectId, RepoError};
use projects_assignments::{ProjectRepository, SqlxProjectRepository};
use sqlx::{Postgres, Transaction};

pub struct ProjectsAssignmentsNameAdapter;

#[async_trait]
impl ProjectNameQuery for ProjectsAssignmentsNameAdapter {
    async fn name(&self, tx: &mut Transaction<'_, Postgres>, id: ProjectId) -> Result<Option<String>, RepoError> {
        let repo = SqlxProjectRepository;
        Ok(repo.find_by_id(tx, id).await?.map(|p| p.name().to_string()))
    }
}
