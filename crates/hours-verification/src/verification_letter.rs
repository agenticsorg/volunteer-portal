//! Prompt 6.1: verification letters as a process, not a stored entity
//! (hours-verification.md's "Verification letters" section). No
//! `VerificationLetter` aggregate, no table -- `VerificationLetterService`
//! is a read-only rollup over `find_approved_by_volunteer_and_range`
//! (Prompt 4.1). The Typst rendering itself lives in `apps/api`'s `infra`
//! layer (ADR-0009), outside this crate, and is handed this module's
//! `VerificationLetterDraft` to turn into PDF bytes.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use identity_access::VolunteerSummaryQuery;
use kernel::{ProjectId, RepoError, VolunteerId};
use rust_decimal::Decimal;
use sqlx::{Postgres, Transaction};

use crate::assignment_snapshot::AssignmentSnapshotQuery;
use crate::hour_entry::HourEntry;
use crate::hours::DateRange;
use crate::repository::HourEntryRepository;

/// A single project's contribution to a letter's total -- one row per
/// distinct project the volunteer logged approved hours against within
/// `range`, sorted by `project_name` for a stable, human-readable letter
/// body (the grouping key is `ProjectId`; display order isn't).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectHours {
    pub project_id: ProjectId,
    pub project_name: String,
    pub hours: Decimal,
}

/// The read model `VerificationLetterService::draft` produces --
/// `apps/api`'s Typst renderer is the only consumer. Never persisted:
/// there is no repository, no `save()`, no table this type round-trips
/// through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationLetterDraft {
    pub volunteer_id: VolunteerId,
    pub volunteer_name: String,
    pub range: DateRange,
    pub total_hours: Decimal,
    pub project_breakdown: Vec<ProjectHours>,
    pub generated_at: DateTime<Utc>,
}

/// Resolves a project's display name for the letter's per-project
/// breakdown. Defined here rather than consumed from `projects-
/// assignments` directly, for the same reason as `AssignmentSnapshotQuery`
/// (`assignment_snapshot.rs`): `hours-verification` and `projects-
/// assignments` are siblings in context-map.md's acyclic dependency
/// graph, neither may depend on the other. Implemented in `apps/api`,
/// delegating to `projects_assignments::ProjectRepository::find_by_id` --
/// no second, hours-verification-local SQL query re-reading the `project`
/// table's `name` column.
#[async_trait::async_trait]
pub trait ProjectNameQuery: Send + Sync {
    async fn name(&self, tx: &mut Transaction<'_, Postgres>, id: ProjectId) -> Result<Option<String>, RepoError>;
}

#[derive(Debug, thiserror::Error)]
pub enum VerificationLetterError {
    #[error(transparent)]
    Repo(#[from] RepoError),
    #[error("volunteer not found")]
    VolunteerNotFound,
    #[error("an approved hour entry references an assignment that no longer exists")]
    AssignmentNotFound,
    #[error("an approved hour entry references a project that no longer exists")]
    ProjectNotFound,
}

pub struct VerificationLetterService<'a> {
    hour_entries: &'a dyn HourEntryRepository,
    assignment_snapshots: &'a dyn AssignmentSnapshotQuery,
    project_names: &'a dyn ProjectNameQuery,
    volunteers: &'a dyn VolunteerSummaryQuery,
}

impl<'a> VerificationLetterService<'a> {
    pub fn new(
        hour_entries: &'a dyn HourEntryRepository,
        assignment_snapshots: &'a dyn AssignmentSnapshotQuery,
        project_names: &'a dyn ProjectNameQuery,
        volunteers: &'a dyn VolunteerSummaryQuery,
    ) -> Self {
        Self {
            hour_entries,
            assignment_snapshots,
            project_names,
            volunteers,
        }
    }

    /// Because `HourEntry` can only ever exist for `Contributor`-mode
    /// assignments (`HourEntry::log`'s invariant), the entries
    /// `find_approved_by_volunteer_and_range` returns are, by
    /// construction, always eligible -- this method applies no
    /// event-type filtering of its own; the exclusion already happened
    /// at the source (hours-verification.md).
    pub async fn draft(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
        range: DateRange,
    ) -> Result<VerificationLetterDraft, VerificationLetterError> {
        let volunteer = self
            .volunteers
            .summary(tx, volunteer_id)
            .await?
            .ok_or(VerificationLetterError::VolunteerNotFound)?;

        // `find_approved_by_volunteer_and_range`'s own `where status =
        // 'approved'` clause is the sole filter -- pending/rejected
        // entries are never even fetched, let alone rolled up. Covered
        // end-to-end (real Postgres, seeded pending/approved/rejected
        // rows) by `apps/api/tests/verification_letter.rs`.
        let entries = self
            .hour_entries
            .find_approved_by_volunteer_and_range(tx, volunteer_id, range)
            .await?;

        let mut entries_with_project = Vec::with_capacity(entries.len());
        for entry in entries {
            let snapshot = self
                .assignment_snapshots
                .snapshot(tx, entry.assignment_id())
                .await?
                .ok_or(VerificationLetterError::AssignmentNotFound)?;
            entries_with_project.push((entry, snapshot.project_id));
        }

        let mut project_ids: Vec<ProjectId> = entries_with_project.iter().map(|(_, id)| *id).collect();
        project_ids.sort();
        project_ids.dedup();

        let mut project_names = BTreeMap::new();
        for project_id in project_ids {
            let name = self
                .project_names
                .name(tx, project_id)
                .await?
                .ok_or(VerificationLetterError::ProjectNotFound)?;
            project_names.insert(project_id, name);
        }

        Ok(build_draft(
            volunteer_id,
            volunteer.name,
            range,
            entries_with_project,
            project_names,
            Utc::now(),
        ))
    }
}

/// The pure sum-and-group step, split out from `draft` so it's testable
/// without a database connection (`sqlx::Transaction` can't be
/// constructed standalone) -- every port call above is I/O; this isn't.
fn build_draft(
    volunteer_id: VolunteerId,
    volunteer_name: String,
    range: DateRange,
    entries_with_project: Vec<(HourEntry, ProjectId)>,
    project_names: BTreeMap<ProjectId, String>,
    generated_at: DateTime<Utc>,
) -> VerificationLetterDraft {
    let mut totals: BTreeMap<ProjectId, Decimal> = BTreeMap::new();
    for (entry, project_id) in &entries_with_project {
        *totals.entry(*project_id).or_insert(Decimal::ZERO) += entry.hours().value();
    }

    let mut total_hours = Decimal::ZERO;
    let mut project_breakdown: Vec<ProjectHours> = totals
        .into_iter()
        .map(|(project_id, hours)| {
            total_hours += hours;
            ProjectHours {
                project_id,
                project_name: project_names.get(&project_id).cloned().unwrap_or_default(),
                hours,
            }
        })
        .collect();
    project_breakdown.sort_by(|a, b| a.project_name.cmp(&b.project_name));

    VerificationLetterDraft {
        volunteer_id,
        volunteer_name,
        range,
        total_hours,
        project_breakdown,
        generated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hour_entry::HourEntryStatus;
    use kernel::{AssignmentId, HourEntryId};

    fn approved_entry(volunteer_id: VolunteerId, assignment_id: AssignmentId, value: i64) -> HourEntry {
        HourEntry::from_persisted(
            HourEntryId::new(),
            volunteer_id,
            assignment_id,
            chrono::NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            crate::hours::Hours::new(Decimal::from(value)).unwrap(),
            "Trail work".to_string(),
            HourEntryStatus::Approved,
            Some(VolunteerId::new()),
            Some(Utc::now()),
            None,
        )
    }

    fn range() -> DateRange {
        DateRange {
            start: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            end: chrono::NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
        }
    }

    #[test]
    fn sums_and_groups_hours_by_project() {
        let volunteer_id = VolunteerId::new();
        let assignment_a = AssignmentId::new();
        let assignment_b = AssignmentId::new();
        let project_trail = ProjectId::new();
        let project_kitchen = ProjectId::new();

        let entries_with_project = vec![
            (approved_entry(volunteer_id, assignment_a, 3), project_trail),
            (approved_entry(volunteer_id, assignment_a, 2), project_trail),
            (approved_entry(volunteer_id, assignment_b, 4), project_kitchen),
        ];
        let mut names = BTreeMap::new();
        names.insert(project_trail, "Trail Cleanup".to_string());
        names.insert(project_kitchen, "Community Kitchen".to_string());

        let draft = build_draft(
            volunteer_id,
            "Jordan Rivera".to_string(),
            range(),
            entries_with_project,
            names,
            Utc::now(),
        );

        assert_eq!(draft.total_hours, Decimal::from(9));
        assert_eq!(draft.project_breakdown.len(), 2);
        // Sorted by project_name: "Community Kitchen" < "Trail Cleanup".
        assert_eq!(draft.project_breakdown[0].project_name, "Community Kitchen");
        assert_eq!(draft.project_breakdown[0].hours, Decimal::from(4));
        assert_eq!(draft.project_breakdown[1].project_name, "Trail Cleanup");
        assert_eq!(draft.project_breakdown[1].hours, Decimal::from(5));
    }

    #[test]
    fn empty_entries_produce_a_zero_total_and_no_breakdown_rows() {
        let volunteer_id = VolunteerId::new();
        let draft = build_draft(
            volunteer_id,
            "Jordan Rivera".to_string(),
            range(),
            Vec::new(),
            BTreeMap::new(),
            Utc::now(),
        );
        assert_eq!(draft.total_hours, Decimal::ZERO);
        assert!(draft.project_breakdown.is_empty());
    }

    #[test]
    fn single_project_breakdown_matches_total() {
        let volunteer_id = VolunteerId::new();
        let assignment_id = AssignmentId::new();
        let project_id = ProjectId::new();
        let mut names = BTreeMap::new();
        names.insert(project_id, "Trail Cleanup".to_string());

        let draft = build_draft(
            volunteer_id,
            "Jordan Rivera".to_string(),
            range(),
            vec![(approved_entry(volunteer_id, assignment_id, 6), project_id)],
            names,
            Utc::now(),
        );
        assert_eq!(draft.total_hours, Decimal::from(6));
        assert_eq!(draft.project_breakdown, vec![ProjectHours {
            project_id,
            project_name: "Trail Cleanup".to_string(),
            hours: Decimal::from(6),
        }]);
    }
}
