//! Prompt 8.1 (concept.md section 8): the admin roster view with
//! filters and CSV export, and the hours report by project and date
//! range. Deliberately thin -- reuses
//! `identity_access::VolunteerRosterQuery` and
//! `hours_verification::HourEntryRepository::find_approved_by_project_and_range`
//! rather than introducing a second reporting query path (this prompt's
//! explicit instruction), and every handler here is `AdminUser`-gated.

use std::collections::BTreeMap;

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::NaiveDate;
use hours_verification::{DateRange, HourEntryRepository, SqlxHourEntryRepository};
use identity_access::{
    Role, SqlxVolunteerRosterQuery, SqlxVolunteerSummaryQuery, VolunteerRosterFilter,
    VolunteerRosterQuery, VolunteerSummaryQuery, VolunteerStatus,
};
use kernel::{Id, ProjectId};
use projects_assignments::{ProjectRepository, SqlxProjectRepository};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RosterQuery {
    status: Option<String>,
    role: Option<String>,
    skill: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// An unparsable `status`/`role` filter value is a `BadRequest`, not a
/// silently-ignored filter -- an admin who mistypes `status=aproved`
/// should see an error, not an unfiltered roster.
fn parse_roster_filter(query: &RosterQuery) -> Result<VolunteerRosterFilter, ApiError> {
    let status = query
        .status
        .as_deref()
        .map(|s| VolunteerStatus::parse(s).ok_or(ApiError::BadRequest))
        .transpose()?;
    let role = query
        .role
        .as_deref()
        .map(|s| Role::parse(s).ok_or(ApiError::BadRequest))
        .transpose()?;
    Ok(VolunteerRosterFilter { status, role, skill: query.skill.clone() })
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "VolunteerRosterRowDto.ts")]
pub struct VolunteerRosterRowDto {
    pub id: Uuid,
    pub name: String,
    pub email: String,
    pub role: String,
    pub status: String,
    pub skills: Vec<String>,
    pub timezone: String,
    /// ADR-0014's self-reported field, surfaced here so an admin can see
    /// per-volunteer country/region alongside the aggregate
    /// `eu_volunteer_count` below.
    pub country_region: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl From<identity_access::VolunteerRosterRow> for VolunteerRosterRowDto {
    fn from(r: identity_access::VolunteerRosterRow) -> Self {
        Self {
            id: r.id.as_uuid(),
            name: r.name,
            email: r.email,
            role: r.role.as_str().to_string(),
            status: r.status.as_str().to_string(),
            skills: r.skills,
            timezone: r.timezone,
            country_region: r.country_region,
            created_at: r.created_at,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "VolunteerRosterPage.ts")]
pub struct VolunteerRosterPage {
    pub rows: Vec<VolunteerRosterRowDto>,
    pub total: i64,
    /// ADR-0014's GDPR Art. 27 monitoring trigger: approved volunteers
    /// whose self-reported country/region is an EU member state.
    /// Crossing 10 is the ADR's signal to revisit the "no standing EU
    /// representative" decision -- independent of `total`/pagination, so
    /// this is the real count regardless of which page is being viewed.
    pub eu_volunteer_count: i64,
}

/// GET /admin/volunteers -- paginated roster view (default page size
/// 50, matching a reasonable admin-UI table page).
pub async fn list_volunteer_roster(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Query(query): Query<RosterQuery>,
) -> Result<Json<VolunteerRosterPage>, ApiError> {
    let filter = parse_roster_filter(&query)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let offset = query.offset.unwrap_or(0).max(0);

    let repo = SqlxVolunteerRosterQuery;
    let mut tx = state
        .db
        .begin_scoped(admin_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let rows = repo
        .roster(&mut tx, &filter, Some(limit), offset)
        .await
        .map_err(|_| ApiError::Internal)?;
    let total = repo.roster_count(&mut tx, &filter).await.map_err(|_| ApiError::Internal)?;
    let eu_volunteer_count = repo.eu_volunteer_count(&mut tx).await.map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(VolunteerRosterPage {
        rows: rows.into_iter().map(Into::into).collect(),
        total,
        eu_volunteer_count,
    }))
}

/// GET /admin/volunteers/export.csv -- the full filtered set,
/// unpaginated (concept.md's "CSV export" is a bulk download, not a
/// paginated view; `limit: None` here is exactly the case this exists
/// to prove doesn't silently truncate a large roster -- see
/// `apps/api/tests/admin_reporting.rs`'s large-roster export test).
pub async fn export_volunteer_roster_csv(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Query(query): Query<RosterQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let filter = parse_roster_filter(&query)?;

    let repo = SqlxVolunteerRosterQuery;
    let mut tx = state
        .db
        .begin_scoped(admin_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let rows = repo
        .roster(&mut tx, &filter, None, 0)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    let mut writer = csv::WriterBuilder::new().from_writer(Vec::new());
    writer
        .write_record([
            "id",
            "name",
            "email",
            "role",
            "status",
            "skills",
            "timezone",
            "country_region",
            "created_at",
        ])
        .map_err(|_| ApiError::Internal)?;
    for row in rows {
        writer
            .write_record([
                row.id.as_uuid().to_string(),
                row.name,
                row.email,
                row.role.as_str().to_string(),
                row.status.as_str().to_string(),
                row.skills.join(";"),
                row.timezone,
                row.country_region.unwrap_or_default(),
                row.created_at.to_rfc3339(),
            ])
            .map_err(|_| ApiError::Internal)?;
    }
    let csv_bytes = writer.into_inner().map_err(|_| ApiError::Internal)?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv".to_string()),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"volunteer-roster.csv\"".to_string()),
        ],
        csv_bytes,
    ))
}

#[derive(Debug, Deserialize)]
pub struct HoursReportQuery {
    project_id: Uuid,
    start: NaiveDate,
    end: NaiveDate,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "HoursReportRow.ts")]
pub struct HoursReportRowDto {
    pub volunteer_id: Uuid,
    pub volunteer_name: String,
    pub hours: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "HoursReport.ts")]
pub struct HoursReportDto {
    pub project_id: Uuid,
    pub project_name: String,
    pub range_start: NaiveDate,
    pub range_end: NaiveDate,
    pub rows: Vec<HoursReportRowDto>,
    pub total_hours: String,
}

/// GET /admin/reports/hours -- approved hours for one project within a
/// date range, grouped by volunteer, per concept.md section 8's "Hours
/// report by project and date range." Reuses
/// `find_approved_by_project_and_range` (the same approved-only,
/// date-bounded shape `VerificationLetterService` already uses per
/// volunteer, Prompt 6.1) so this report's totals can never drift from
/// what a volunteer's own verification letter would show for the same
/// underlying data.
pub async fn hours_report(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Query(query): Query<HoursReportQuery>,
) -> Result<Json<HoursReportDto>, ApiError> {
    if query.start > query.end {
        return Err(ApiError::BadRequest);
    }
    let project_id: ProjectId = Id::from_uuid(query.project_id);

    let mut tx = state
        .db
        .begin_scoped(admin_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    let project_repo = SqlxProjectRepository;
    let project = project_repo
        .find_by_id(&mut tx, project_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    let hour_entries = SqlxHourEntryRepository;
    let entries = hour_entries
        .find_approved_by_project_and_range(
            &mut tx,
            project_id,
            DateRange { start: query.start, end: query.end },
        )
        .await
        .map_err(|_| ApiError::Internal)?;

    let mut totals_by_volunteer: BTreeMap<Uuid, Decimal> = BTreeMap::new();
    for entry in &entries {
        *totals_by_volunteer.entry(entry.volunteer_id().as_uuid()).or_insert(Decimal::ZERO) += entry.hours().value();
    }

    let volunteers = SqlxVolunteerSummaryQuery;
    let mut rows = Vec::with_capacity(totals_by_volunteer.len());
    let mut total_hours = Decimal::ZERO;
    for (volunteer_id, hours) in totals_by_volunteer {
        let summary = volunteers
            .summary(&mut tx, Id::from_uuid(volunteer_id))
            .await
            .map_err(|_| ApiError::Internal)?
            .ok_or(ApiError::Internal)?;
        total_hours += hours;
        rows.push(HoursReportRowDto {
            volunteer_id,
            volunteer_name: summary.name,
            hours: hours.to_string(),
        });
    }
    rows.sort_by(|a, b| a.volunteer_name.cmp(&b.volunteer_name));
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(HoursReportDto {
        project_id: project_id.as_uuid(),
        project_name: project.name().to_string(),
        range_start: query.start,
        range_end: query.end,
        rows,
        total_hours: total_hours.to_string(),
    }))
}
