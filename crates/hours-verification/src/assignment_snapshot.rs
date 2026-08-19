use async_trait::async_trait;
use kernel::{AssignmentId, ProjectId, RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};

/// Local to this crate, deliberately -- context-map.md's acyclic
/// dependency graph places `hours-verification` and `projects-assignments`
/// as siblings (both depend on `kernel`/`identity-access`; neither depends
/// on the other), so this is not the same Rust type as
/// `projects_assignments::ParticipationMode`, just a structurally
/// identical read-model copy translated at the `AssignmentSnapshotQuery`
/// implementation boundary (`SqlxAssignmentSnapshotQuery`, in
/// `repository.rs`, reads the shared `assignment` table's `participation_mode`
/// text column directly rather than importing the other crate's enum).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticipationMode {
    Contributor,
    Attendee,
}

impl ParticipationMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "contributor" => Some(ParticipationMode::Contributor),
            "attendee" => Some(ParticipationMode::Attendee),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssignmentStatus {
    Applied,
    Approved,
    Removed,
}

impl AssignmentStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "applied" => Some(AssignmentStatus::Applied),
            "approved" => Some(AssignmentStatus::Approved),
            "removed" => Some(AssignmentStatus::Removed),
            _ => None,
        }
    }
}

/// A minimal, read-only view of the `Assignment` an `HourEntry` is logged
/// against -- obtained via `AssignmentSnapshotQuery`, not by this context
/// reaching into `projects-assignments`'s aggregate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssignmentSnapshot {
    pub assignment_id: AssignmentId,
    pub volunteer_id: VolunteerId,
    pub project_id: ProjectId,
    pub participation_mode: ParticipationMode,
    pub status: AssignmentStatus,
}

#[async_trait]
pub trait AssignmentSnapshotQuery: Send + Sync {
    async fn snapshot(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: AssignmentId,
    ) -> Result<Option<AssignmentSnapshot>, RepoError>;
}
