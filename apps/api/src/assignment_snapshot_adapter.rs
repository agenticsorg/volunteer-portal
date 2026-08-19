//! The concrete `hours_verification::AssignmentSnapshotQuery` implementation
//! lives here, in the composition root, rather than in `hours-verification`
//! itself -- context-map.md's acyclic dependency graph forbids
//! `hours-verification` depending on `projects-assignments` (they are
//! siblings), but `apps/api` already depends on both, so this is the one
//! place allowed to bridge them. Delegates to
//! `projects_assignments::SqlxAssignmentRepository::find_by_id` and
//! `Assignment`'s existing accessors -- no new SQL, no second
//! `participation_mode` parser, single source of truth stays in
//! `projects-assignments` (per the 2026-08-19 architecture-consistency
//! amendment to hours-verification.md and context-map.md).

use async_trait::async_trait;
use hours_verification::{AssignmentSnapshot, AssignmentSnapshotQuery, AssignmentStatus, ParticipationMode};
use kernel::{AssignmentId, RepoError};
use projects_assignments::{AssignmentRepository, SqlxAssignmentRepository};
use sqlx::{Postgres, Transaction};

pub struct ProjectsAssignmentsSnapshotAdapter;

#[async_trait]
impl AssignmentSnapshotQuery for ProjectsAssignmentsSnapshotAdapter {
    async fn snapshot(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: AssignmentId,
    ) -> Result<Option<AssignmentSnapshot>, RepoError> {
        let repo = SqlxAssignmentRepository;
        let Some(assignment) = repo.find_by_id(tx, id).await? else {
            return Ok(None);
        };

        let participation_mode = match assignment.participation_mode() {
            projects_assignments::ParticipationMode::Contributor => ParticipationMode::Contributor,
            projects_assignments::ParticipationMode::Attendee => ParticipationMode::Attendee,
        };
        let status = match assignment.status() {
            projects_assignments::AssignmentStatus::Applied => AssignmentStatus::Applied,
            projects_assignments::AssignmentStatus::Approved => AssignmentStatus::Approved,
            projects_assignments::AssignmentStatus::Removed => AssignmentStatus::Removed,
        };

        Ok(Some(AssignmentSnapshot {
            assignment_id: assignment.id(),
            volunteer_id: assignment.volunteer_id(),
            project_id: assignment.project_id(),
            participation_mode,
            status,
        }))
    }
}
