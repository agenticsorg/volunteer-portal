use async_trait::async_trait;
use kernel::{DomainEvent, HourEntryId, Id, ProjectId, RepoError, VolunteerId};
use rust_decimal::Decimal;
use sqlx::{Postgres, Transaction};

use crate::hour_entry::{Adjustment, HourEntry, HourEntryStatus};
use crate::hours::{DateRange, Hours};

#[async_trait]
pub trait HourEntryRepository: Send + Sync {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: HourEntryId,
    ) -> Result<Option<HourEntry>, RepoError>;

    /// Approval queue.
    async fn find_pending_for_lead(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        lead_id: VolunteerId,
    ) -> Result<Vec<HourEntry>, RepoError>;

    /// Feeds `VerificationLetterService` (Prompt 6.1) and the admin
    /// hours report.
    async fn find_approved_by_volunteer_and_range(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
        range: DateRange,
    ) -> Result<Vec<HourEntry>, RepoError>;

    /// Prompt 8.1's "hours report by project and date range" -- the
    /// same shape as `find_approved_by_volunteer_and_range` (approved-
    /// only, date-range-filtered), scoped by project instead of
    /// volunteer, so the report reuses this repository's existing query
    /// pattern rather than a second, drift-prone reporting path.
    async fn find_approved_by_project_and_range(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        range: DateRange,
    ) -> Result<Vec<HourEntry>, RepoError>;

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        entry: &mut HourEntry,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}

pub struct SqlxHourEntryRepository;

#[allow(clippy::too_many_arguments)]
fn row_to_hour_entry(
    id: uuid::Uuid,
    volunteer_id: uuid::Uuid,
    assignment_id: uuid::Uuid,
    date: chrono::NaiveDate,
    hours: Decimal,
    description: String,
    status: String,
    approver_id: Option<uuid::Uuid>,
    decided_at: Option<chrono::DateTime<chrono::Utc>>,
    adjustment_adjusted_by: Option<uuid::Uuid>,
    adjustment_previous_hours: Option<Decimal>,
    adjustment_reason: Option<String>,
    adjustment_adjusted_at: Option<chrono::DateTime<chrono::Utc>>,
) -> HourEntry {
    let adjustment = adjustment_adjusted_by.map(|adjusted_by| Adjustment {
        adjusted_by: Id::from_uuid(adjusted_by),
        previous_hours: Hours::new(adjustment_previous_hours.expect("adjustment row must be complete"))
            .expect("persisted adjustment previous_hours must already be valid"),
        reason: adjustment_reason.expect("adjustment row must be complete"),
        adjusted_at: adjustment_adjusted_at.expect("adjustment row must be complete"),
    });

    HourEntry::from_persisted(
        Id::from_uuid(id),
        Id::from_uuid(volunteer_id),
        Id::from_uuid(assignment_id),
        date,
        Hours::new(hours).expect("persisted hours must already be valid"),
        description,
        HourEntryStatus::parse(&status).expect("status column must be a valid HourEntryStatus"),
        approver_id.map(Id::from_uuid),
        decided_at,
        adjustment,
    )
}

#[async_trait]
impl HourEntryRepository for SqlxHourEntryRepository {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: HourEntryId,
    ) -> Result<Option<HourEntry>, RepoError> {
        let row = sqlx::query!(
            r#"select id, volunteer_id, assignment_id, date, hours, description, status,
                      approver_id,
                      decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      adjustment_adjusted_by, adjustment_previous_hours, adjustment_reason,
                      adjustment_adjusted_at as "adjustment_adjusted_at: chrono::DateTime<chrono::Utc>"
               from hour_entry where id = $1"#,
            id.as_uuid()
        )
        .fetch_optional(&mut **tx)
        .await?;

        Ok(row.map(|r| {
            row_to_hour_entry(
                r.id,
                r.volunteer_id,
                r.assignment_id,
                r.date,
                r.hours,
                r.description,
                r.status,
                r.approver_id,
                r.decided_at,
                r.adjustment_adjusted_by,
                r.adjustment_previous_hours,
                r.adjustment_reason,
                r.adjustment_adjusted_at,
            )
        }))
    }

    async fn find_pending_for_lead(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        lead_id: VolunteerId,
    ) -> Result<Vec<HourEntry>, RepoError> {
        // Explicitly filtered by `lead_id` via `project_lead` (matching
        // `SqlxProjectRepository::is_lead_of_project`'s explicit-
        // parameter style elsewhere in this codebase), with RLS's own
        // `hour_entry_select` policy as an independent second layer --
        // the same defense-in-depth posture ADR-0004 applies throughout.
        let rows = sqlx::query!(
            r#"select he.id, he.volunteer_id, he.assignment_id, he.date, he.hours, he.description,
                      he.status, he.approver_id,
                      he.decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      he.adjustment_adjusted_by, he.adjustment_previous_hours, he.adjustment_reason,
                      he.adjustment_adjusted_at as "adjustment_adjusted_at: chrono::DateTime<chrono::Utc>"
               from hour_entry he
               join assignment a on a.id = he.assignment_id
               join project_lead pl on pl.project_id = a.project_id
               where he.status = 'pending' and pl.volunteer_id = $1"#,
            lead_id.as_uuid(),
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                row_to_hour_entry(
                    r.id,
                    r.volunteer_id,
                    r.assignment_id,
                    r.date,
                    r.hours,
                    r.description,
                    r.status,
                    r.approver_id,
                    r.decided_at,
                    r.adjustment_adjusted_by,
                    r.adjustment_previous_hours,
                    r.adjustment_reason,
                    r.adjustment_adjusted_at,
                )
            })
            .collect())
    }

    async fn find_approved_by_volunteer_and_range(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
        range: DateRange,
    ) -> Result<Vec<HourEntry>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, volunteer_id, assignment_id, date, hours, description, status,
                      approver_id,
                      decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      adjustment_adjusted_by, adjustment_previous_hours, adjustment_reason,
                      adjustment_adjusted_at as "adjustment_adjusted_at: chrono::DateTime<chrono::Utc>"
               from hour_entry
               where volunteer_id = $1 and status = 'approved' and date >= $2 and date <= $3
               order by date asc"#,
            volunteer_id.as_uuid(),
            range.start,
            range.end,
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                row_to_hour_entry(
                    r.id,
                    r.volunteer_id,
                    r.assignment_id,
                    r.date,
                    r.hours,
                    r.description,
                    r.status,
                    r.approver_id,
                    r.decided_at,
                    r.adjustment_adjusted_by,
                    r.adjustment_previous_hours,
                    r.adjustment_reason,
                    r.adjustment_adjusted_at,
                )
            })
            .collect())
    }

    async fn find_approved_by_project_and_range(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        range: DateRange,
    ) -> Result<Vec<HourEntry>, RepoError> {
        let rows = sqlx::query!(
            r#"select he.id, he.volunteer_id, he.assignment_id, he.date, he.hours, he.description,
                      he.status, he.approver_id,
                      he.decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      he.adjustment_adjusted_by, he.adjustment_previous_hours, he.adjustment_reason,
                      he.adjustment_adjusted_at as "adjustment_adjusted_at: chrono::DateTime<chrono::Utc>"
               from hour_entry he
               join assignment a on a.id = he.assignment_id
               where a.project_id = $1 and he.status = 'approved' and he.date >= $2 and he.date <= $3
               order by he.date asc"#,
            project_id.as_uuid(),
            range.start,
            range.end,
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                row_to_hour_entry(
                    r.id,
                    r.volunteer_id,
                    r.assignment_id,
                    r.date,
                    r.hours,
                    r.description,
                    r.status,
                    r.approver_id,
                    r.decided_at,
                    r.adjustment_adjusted_by,
                    r.adjustment_previous_hours,
                    r.adjustment_reason,
                    r.adjustment_adjusted_at,
                )
            })
            .collect())
    }

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        entry: &mut HourEntry,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError> {
        let adjustment = entry.adjustment();
        sqlx::query!(
            r#"insert into hour_entry (id, volunteer_id, assignment_id, date, hours, description,
                                        status, approver_id, decided_at,
                                        adjustment_adjusted_by, adjustment_previous_hours,
                                        adjustment_reason, adjustment_adjusted_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               on conflict (id) do update set
                   hours = excluded.hours,
                   status = excluded.status,
                   approver_id = excluded.approver_id,
                   decided_at = excluded.decided_at,
                   adjustment_adjusted_by = excluded.adjustment_adjusted_by,
                   adjustment_previous_hours = excluded.adjustment_previous_hours,
                   adjustment_reason = excluded.adjustment_reason,
                   adjustment_adjusted_at = excluded.adjustment_adjusted_at"#,
            entry.id().as_uuid(),
            entry.volunteer_id().as_uuid(),
            entry.assignment_id().as_uuid(),
            entry.date(),
            entry.hours().value(),
            entry.description(),
            entry.status().as_str(),
            entry.approver_id().map(|id| id.as_uuid()),
            entry.decided_at(),
            adjustment.map(|a| a.adjusted_by.as_uuid()),
            adjustment.map(|a| a.previous_hours.value()),
            adjustment.map(|a| a.reason.clone()),
            adjustment.map(|a| a.adjusted_at),
        )
        .execute(&mut **tx)
        .await?;

        Ok(entry.take_events())
    }
}

/// concept.md section 5: "cumulative totals per volunteer and per
/// project." Sums `hours` (which already reflects the current,
/// possibly-adjusted value -- `HourEntry::adjust` overwrites it, keeping
/// `adjustment.previous_hours` as the historical record) across
/// `approved` entries only, matching `find_approved_by_volunteer_and_range`'s
/// same "approved only" scope.
#[async_trait]
pub trait HoursTotalsQuery: Send + Sync {
    async fn total_for_volunteer(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Decimal, RepoError>;

    async fn total_for_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
    ) -> Result<Decimal, RepoError>;
}

#[async_trait]
impl HoursTotalsQuery for SqlxHourEntryRepository {
    async fn total_for_volunteer(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Decimal, RepoError> {
        let total: Option<Decimal> = sqlx::query_scalar!(
            r#"select sum(hours) from hour_entry where volunteer_id = $1 and status = 'approved'"#,
            volunteer_id.as_uuid()
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(total.unwrap_or(Decimal::ZERO))
    }

    async fn total_for_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
    ) -> Result<Decimal, RepoError> {
        let total: Option<Decimal> = sqlx::query_scalar!(
            r#"select sum(he.hours) from hour_entry he
               join assignment a on a.id = he.assignment_id
               where a.project_id = $1 and he.status = 'approved'"#,
            project_id.as_uuid()
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(total.unwrap_or(Decimal::ZERO))
    }
}
