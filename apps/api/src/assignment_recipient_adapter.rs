//! The concrete `notifications::AssignmentRecipientQuery` implementation
//! lives here, in the composition root, for the same reason as
//! `assignment_snapshot_adapter.rs`/`project_name_adapter.rs`:
//! `notifications` cannot depend on `projects-assignments`
//! (context-map.md's acyclic dependency graph places them as siblings
//! under `identity-access`), but `apps/api` already depends on both.
//! Resolves `AssignmentApproved`'s outbox payload (`assignment_id`
//! only) into the actual recipient and their project's display name.

use async_trait::async_trait;
use kernel::RepoError;
use notifications::{AssignmentRecipient, AssignmentRecipientQuery};
use projects_assignments::{AssignmentRepository, ProjectRepository, SqlxAssignmentRepository, SqlxProjectRepository};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub struct ProjectsAssignmentsRecipientAdapter;

#[async_trait]
impl AssignmentRecipientQuery for ProjectsAssignmentsRecipientAdapter {
    async fn recipient_for_assignment(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        assignment_id: Uuid,
    ) -> Result<Option<AssignmentRecipient>, RepoError> {
        let assignment_repo = SqlxAssignmentRepository;
        let Some(assignment) = assignment_repo.find_by_id(tx, kernel::Id::from_uuid(assignment_id)).await? else {
            return Ok(None);
        };

        let project_repo = SqlxProjectRepository;
        let Some(project) = project_repo.find_by_id(tx, assignment.project_id()).await? else {
            return Ok(None);
        };

        Ok(Some(AssignmentRecipient {
            volunteer_id: assignment.volunteer_id(),
            project_name: project.name().to_string(),
        }))
    }
}
