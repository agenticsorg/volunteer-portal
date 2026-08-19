//! Prompt 4.2: self-logged hour entries, the lead approval queue with
//! bulk approve, admin-only manual adjustment, and cumulative totals
//! (concept.md sections 5 and 8).
//!
//! Bulk approve re-checks `LeadMembershipQuery` per entry (via each
//! entry's `AssignmentSnapshotQuery`-resolved `project_id`) rather than
//! relying on a single path-scoped extractor, since a batch can span
//! multiple projects a lead leads -- hours-verification.md's explicit
//! "Other invariants" note. The same per-entry check backs single-entry
//! reject.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::NaiveDate;
use hours_verification::{HourEntry, HourEntryRepository, Hours, HoursTotalsQuery, SqlxHourEntryRepository};
use identity_access::{Role, SqlxVolunteerSummaryQuery, VolunteerSummaryQuery};
use kernel::{record_audit_events, HourEntryId, Id, ProjectId, VolunteerId};
use rust_decimal::Decimal;
use serde::Deserialize;
use sqlx::{Postgres, Transaction};
use ts_rs::TS;
use uuid::Uuid;

use crate::auth::{AdminUser, AuthUser, LeadOfOrAdmin};
use crate::dto::HourEntryDto;
use crate::error::ApiError;
use crate::state::AppState;

fn parse_hours(raw: &str) -> Result<Hours, ApiError> {
    let decimal: Decimal = raw.parse().map_err(|_| ApiError::BadRequest)?;
    Hours::new(decimal).map_err(|_| ApiError::BadRequest)
}

/// Shared by bulk-approve and reject: a caller may act on an entry if
/// they lead the entry's assignment's project, or are an admin -- the
/// same admin-or-lead shape as `LeadOfOrAdmin`, but resolved from an
/// entry's `assignment_id` rather than a path parameter.
async fn is_authorized_for_project(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    caller_id: VolunteerId,
    project_id: ProjectId,
) -> Result<bool, ApiError> {
    if state
        .lead_membership
        .is_lead_of_project(tx, caller_id, project_id)
        .await
        .map_err(|_| ApiError::Internal)?
    {
        return Ok(true);
    }
    let summary_query = SqlxVolunteerSummaryQuery;
    Ok(summary_query
        .summary(tx, caller_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .is_some_and(|s| s.role == Role::Admin))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "LogHoursRequest.ts")]
pub struct LogHoursRequest {
    pub date: NaiveDate,
    pub hours: String,
    pub description: String,
}

/// POST /assignments/{assignment_id}/hours -- self-logged only. The
/// `hour_entry_insert` RLS policy already enforces `volunteer_id =
/// current_actor_id()`, but this checks it explicitly first so a
/// mismatch (logging against someone else's assignment) comes back as a
/// clean 403 rather than leaning on an RLS-denied database error
/// surfacing as a 500 -- same principle as Prompt 3.3's
/// `ensure_scoped_to`.
pub async fn log_hours(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
    Path(assignment_id): Path<Uuid>,
    Json(payload): Json<LogHoursRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let assignment_id = Id::from_uuid(assignment_id);
    let hours = parse_hours(&payload.hours)?;

    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    let snapshot = state
        .assignment_snapshot
        .snapshot(&mut tx, assignment_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    if snapshot.volunteer_id != volunteer_id {
        return Err(ApiError::Forbidden);
    }

    let mut entry = HourEntry::log(&snapshot, payload.date, hours, payload.description)
        .map_err(|_| ApiError::BadRequest)?;

    let repo = SqlxHourEntryRepository;
    let events = repo
        .save(&mut tx, &mut entry)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok((StatusCode::CREATED, Json(entry.id().to_string())))
}

/// GET /hours/pending -- the caller's lead approval queue, spanning
/// every project they lead (concept.md section 5's "bulk approve" implies
/// a cross-project queue, not one scoped to a single `LeadOf` path).
pub async fn list_pending_hours(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<HourEntryDto>>, ApiError> {
    let repo = SqlxHourEntryRepository;
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let entries = repo
        .find_pending_for_lead(&mut tx, volunteer_id)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "BulkApproveHoursRequest.ts")]
pub struct BulkApproveHoursRequest {
    pub hour_entry_ids: Vec<Uuid>,
}

#[derive(Debug, serde::Serialize, TS)]
#[ts(export, export_to = "BulkApproveHoursResult.ts")]
pub struct BulkApproveHoursResult {
    pub approved: Vec<Uuid>,
    pub failed: Vec<BulkApproveFailure>,
}

#[derive(Debug, serde::Serialize, TS)]
#[ts(export, export_to = "BulkApproveFailure.ts")]
pub struct BulkApproveFailure {
    pub hour_entry_id: Uuid,
    pub reason: String,
}

/// POST /hours/approve -- bulk approve, re-checking authorization per
/// entry (see module docs). Partial-failure model: one entry being
/// already-decided, or belonging to a project the caller doesn't lead,
/// doesn't abort the rest of the batch.
pub async fn bulk_approve_hours(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<BulkApproveHoursRequest>,
) -> Result<Json<BulkApproveHoursResult>, ApiError> {
    let repo = SqlxHourEntryRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    let mut result = BulkApproveHoursResult {
        approved: Vec::new(),
        failed: Vec::new(),
    };
    let mut all_events: Vec<Box<dyn kernel::DomainEvent>> = Vec::new();

    for raw_id in payload.hour_entry_ids {
        let entry_id: HourEntryId = Id::from_uuid(raw_id);
        let Some(mut entry) = repo
            .find_by_id(&mut tx, entry_id)
            .await
            .map_err(|_| ApiError::Internal)?
        else {
            result.failed.push(BulkApproveFailure {
                hour_entry_id: raw_id,
                reason: "not found".to_string(),
            });
            continue;
        };

        let Some(snapshot) = state
            .assignment_snapshot
            .snapshot(&mut tx, entry.assignment_id())
            .await
            .map_err(|_| ApiError::Internal)?
        else {
            result.failed.push(BulkApproveFailure {
                hour_entry_id: raw_id,
                reason: "assignment not found".to_string(),
            });
            continue;
        };

        let is_authorized =
            is_authorized_for_project(&state, &mut tx, caller_id, snapshot.project_id).await?;

        match entry.approve(caller_id, is_authorized) {
            Ok(()) => {
                let events = repo
                    .save(&mut tx, &mut entry)
                    .await
                    .map_err(|_| ApiError::Internal)?;
                all_events.extend(events);
                result.approved.push(raw_id);
            }
            Err(err) => {
                result.failed.push(BulkApproveFailure {
                    hour_entry_id: raw_id,
                    reason: err.to_string(),
                });
            }
        }
    }

    record_audit_events(&mut tx, &all_events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(result))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "RejectHoursRequest.ts")]
pub struct RejectHoursRequest {
    pub reason: Option<String>,
}

/// POST /hours/{hour_entry_id}/reject -- same admin-or-lead
/// authorization shape as bulk approve, for a single entry.
pub async fn reject_hours(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    Path(hour_entry_id): Path<Uuid>,
    Json(payload): Json<RejectHoursRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let entry_id: HourEntryId = Id::from_uuid(hour_entry_id);
    let repo = SqlxHourEntryRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    let mut entry = repo
        .find_by_id(&mut tx, entry_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    let snapshot = state
        .assignment_snapshot
        .snapshot(&mut tx, entry.assignment_id())
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Internal)?;

    let is_authorized =
        is_authorized_for_project(&state, &mut tx, caller_id, snapshot.project_id).await?;

    entry
        .reject(caller_id, is_authorized, payload.reason)
        .map_err(|_| ApiError::BadRequest)?;

    let events = repo
        .save(&mut tx, &mut entry)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "AdjustHoursRequest.ts")]
pub struct AdjustHoursRequest {
    pub new_hours: String,
    pub reason: String,
}

/// POST /admin/hours/{hour_entry_id}/adjust -- admin-only (not lead),
/// per concept.md section 8 and hours-verification.md's invariant.
/// `AdminUser` alone gates this, matching `HourEntry::adjust`'s
/// `is_admin` parameter being unconditionally `true` here.
pub async fn adjust_hours(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Path(hour_entry_id): Path<Uuid>,
    Json(payload): Json<AdjustHoursRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let entry_id: HourEntryId = Id::from_uuid(hour_entry_id);
    let new_hours = parse_hours(&payload.new_hours)?;
    let repo = SqlxHourEntryRepository;
    let mut tx = state
        .db
        .begin_scoped(admin_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    let mut entry = repo
        .find_by_id(&mut tx, entry_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    entry
        .adjust(admin_id, true, new_hours, payload.reason)
        .map_err(|_| ApiError::BadRequest)?;

    let events = repo
        .save(&mut tx, &mut entry)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, serde::Serialize, TS)]
#[ts(export, export_to = "HoursTotal.ts")]
pub struct HoursTotalDto {
    pub total_hours: String,
}

/// GET /volunteers/{volunteer_id}/hours/total -- concept.md section 5's
/// "cumulative totals per volunteer." Self or admin (not lead -- a
/// volunteer's total spans every project, not one a given lead runs).
pub async fn volunteer_hours_total(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    Path(volunteer_id): Path<Uuid>,
) -> Result<Json<HoursTotalDto>, ApiError> {
    let volunteer_id: VolunteerId = Id::from_uuid(volunteer_id);
    let repo = SqlxHourEntryRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    if caller_id != volunteer_id {
        let summary_query = SqlxVolunteerSummaryQuery;
        let is_admin = summary_query
            .summary(&mut tx, caller_id)
            .await
            .map_err(|_| ApiError::Internal)?
            .is_some_and(|s| s.role == Role::Admin);
        if !is_admin {
            return Err(ApiError::Forbidden);
        }
    }

    let total = repo
        .total_for_volunteer(&mut tx, volunteer_id)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(HoursTotalDto {
        total_hours: total.to_string(),
    }))
}

/// GET /projects/{project_id}/hours/total -- concept.md section 5's
/// "cumulative totals ... per project." Lead- or admin-scoped, matching
/// the roster view's authorization shape.
pub async fn project_hours_total(
    AuthUser(caller_id): AuthUser,
    LeadOfOrAdmin(project_id): LeadOfOrAdmin,
    State(state): State<AppState>,
) -> Result<Json<HoursTotalDto>, ApiError> {
    let repo = SqlxHourEntryRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let total = repo
        .total_for_project(&mut tx, project_id)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(HoursTotalDto {
        total_hours: total.to_string(),
    }))
}
