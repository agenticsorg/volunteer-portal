//! Prompt 10.2 (compliance-audit.md's "Aggregate: `DataSubjectRequest`"):
//! the PIPEDA/GDPR export and deletion request lifecycle. A volunteer
//! files their own request; an admin (`AdminUser`-gated, invariant 3)
//! starts, completes, or rejects it. `Export` is a read-only aggregation
//! across `identity-access`, `projects-assignments`, and
//! `hours-verification` -- assembled here, not in `compliance-audit`,
//! since that crate deliberately depends on `identity-access` only (see
//! its module doc). `Deletion` delegates to
//! `compliance_audit::complete_deletion`, which *does* live in that
//! crate (permitted: `compliance-audit -> identity-access` is the one
//! sibling dependency context-map.md's acyclic graph allows).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use compliance_audit::{
    complete_deletion, CompletionMethod, DataSubjectRequest, DataSubjectRequestRepository, RequestStatus,
    RequestType, SqlxDataSubjectRequestRepository,
};
use hours_verification::{HourEntryRepository, SqlxHourEntryRepository};
use identity_access::{SqlxVolunteerRepository, VolunteerRepository};
use kernel::{record_audit_events, record_outbox_events, DataSubjectRequestId, Id};
use projects_assignments::{AssignmentRepository, SqlxAssignmentRepository};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::auth::{AdminUser, AuthUser};
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "DataSubjectRequestDto.ts")]
pub struct DataSubjectRequestDto {
    pub id: Uuid,
    pub volunteer_id: Uuid,
    pub request_type: String,
    pub status: String,
    pub requested_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub handled_by: Option<Uuid>,
    pub rejection_reason: Option<String>,
}

impl From<&DataSubjectRequest> for DataSubjectRequestDto {
    fn from(r: &DataSubjectRequest) -> Self {
        Self {
            id: r.id().as_uuid(),
            volunteer_id: r.volunteer_id().as_uuid(),
            request_type: r.request_type().as_str().to_string(),
            status: r.status().as_str().to_string(),
            requested_at: r.requested_at(),
            completed_at: r.completed_at(),
            handled_by: r.handled_by().map(|id| id.as_uuid()),
            rejection_reason: r.rejection_reason().map(str::to_string),
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "FileDataSubjectRequestRequest.ts")]
pub struct FileDataSubjectRequestRequest {
    pub request_type: String,
}

/// POST /volunteers/me/data-subject-requests -- a volunteer files their
/// own export or deletion request. Self-only: there is no path for one
/// volunteer to file a request naming another (an admin filing on a
/// volunteer's behalf, e.g. a request received by email, uses the same
/// RLS-permitted insert directly -- not exposed as a distinct endpoint
/// here since no admin workflow needs it yet).
pub async fn file_request(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<FileDataSubjectRequestRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let request_type = RequestType::parse(&payload.request_type).ok_or(ApiError::BadRequest)?;

    let repo = SqlxDataSubjectRequestRepository;
    let mut tx = state.db.begin_scoped(volunteer_id.as_uuid()).await.map_err(|_| ApiError::Internal)?;

    let mut request = DataSubjectRequest::receive(volunteer_id, request_type);
    let events = repo.save(&mut tx, &mut request).await.map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events).await.map_err(|_| ApiError::Internal)?;
    record_outbox_events(&mut tx, &events).await.map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok((StatusCode::CREATED, Json(DataSubjectRequestDto::from(&request))))
}

/// GET /volunteers/me/data-subject-requests -- a volunteer's own request
/// history (RLS's `data_subject_request_select` already scopes this to
/// `volunteer_id = current_actor_id()`, but the query is written
/// explicitly here too, matching this codebase's defense-in-depth
/// posture elsewhere).
pub async fn list_own_requests(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<DataSubjectRequestDto>>, ApiError> {
    let repo = SqlxDataSubjectRequestRepository;
    let mut tx = state.db.begin_scoped(volunteer_id.as_uuid()).await.map_err(|_| ApiError::Internal)?;
    let requests = repo.find_by_volunteer(&mut tx, volunteer_id).await.map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;
    Ok(Json(requests.iter().map(DataSubjectRequestDto::from).collect()))
}

/// GET /admin/data-subject-requests -- the admin queue (`Received` and
/// `InProgress`, oldest first).
pub async fn list_pending_requests(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<DataSubjectRequestDto>>, ApiError> {
    let repo = SqlxDataSubjectRequestRepository;
    let mut tx = state.db.begin_scoped(admin_id.as_uuid()).await.map_err(|_| ApiError::Internal)?;
    let requests = repo.find_pending(&mut tx).await.map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;
    Ok(Json(requests.iter().map(DataSubjectRequestDto::from).collect()))
}

/// POST /admin/data-subject-requests/{id}/start -- an admin claims a
/// `Received` request. No `AuditableEvent` is produced (see
/// `DataSubjectRequest::start`'s doc comment) -- the row's own `status`
/// and `handled_by` are the record, which this endpoint's response and
/// `list_pending_requests` both expose.
pub async fn start_request(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let id: DataSubjectRequestId = Id::from_uuid(id);
    let repo = SqlxDataSubjectRequestRepository;
    let mut tx = state.db.begin_scoped(admin_id.as_uuid()).await.map_err(|_| ApiError::Internal)?;

    let mut request = repo.find_by_id(&mut tx, id).await.map_err(|_| ApiError::Internal)?.ok_or(ApiError::NotFound)?;
    request.start(admin_id).map_err(|_| ApiError::BadRequest)?;
    repo.save(&mut tx, &mut request).await.map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(DataSubjectRequestDto::from(&request)))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "RejectDataSubjectRequestRequest.ts")]
pub struct RejectDataSubjectRequestRequest {
    pub reason: String,
}

/// POST /admin/data-subject-requests/{id}/reject -- invariant 2's narrow
/// grounds (a live legal hold or unresolved dispute) are guidance for
/// the handling admin, not enforced here; invariant 1's non-empty-reason
/// rule *is* enforced, both here (`DataSubjectRequest::reject`) and by
/// the migration's CHECK constraint.
pub async fn reject_request(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<RejectDataSubjectRequestRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let id: DataSubjectRequestId = Id::from_uuid(id);
    let repo = SqlxDataSubjectRequestRepository;
    let mut tx = state.db.begin_scoped(admin_id.as_uuid()).await.map_err(|_| ApiError::Internal)?;

    let mut request = repo.find_by_id(&mut tx, id).await.map_err(|_| ApiError::Internal)?.ok_or(ApiError::NotFound)?;
    request.reject(admin_id, payload.reason).map_err(|_| ApiError::BadRequest)?;
    repo.save(&mut tx, &mut request).await.map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(DataSubjectRequestDto::from(&request)))
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "VolunteerExportDto.ts")]
pub struct VolunteerExportDto {
    pub id: Uuid,
    pub name: String,
    pub email: String,
    pub discord_id: Option<String>,
    pub timezone: String,
    pub skills: Vec<String>,
    #[ts(type = "unknown")]
    pub availability: serde_json::Value,
    pub country_region: Option<String>,
    pub status: String,
    pub role: String,
    pub code_of_conduct_accepted_at: Option<DateTime<Utc>>,
    pub ip_agreement_accepted_at: Option<DateTime<Utc>>,
    pub age_attestation_confirmed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "AssignmentExportDto.ts")]
pub struct AssignmentExportDto {
    pub id: Uuid,
    pub project_id: Uuid,
    pub role: String,
    pub participation_mode: String,
    pub status: String,
    pub applied_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
    pub attended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "HourEntryExportDto.ts")]
pub struct HourEntryExportDto {
    pub id: Uuid,
    pub assignment_id: Uuid,
    pub date: chrono::NaiveDate,
    pub hours: String,
    pub description: String,
    pub status: String,
    pub decided_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "VolunteerDataExportDto.ts")]
pub struct VolunteerDataExportDto {
    pub volunteer: VolunteerExportDto,
    pub assignments: Vec<AssignmentExportDto>,
    pub hour_entries: Vec<HourEntryExportDto>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "CompleteDataSubjectRequestResponse.ts")]
pub struct CompleteDataSubjectRequestResponse {
    pub request: DataSubjectRequestDto,
    /// `Some` only for a completed `Export` request -- `Deletion`
    /// completion returns no data package (there is nothing left to
    /// export once the volunteer has been anonymized).
    pub export: Option<VolunteerDataExportDto>,
}

/// POST /admin/data-subject-requests/{id}/complete -- branches on
/// `request_type`. `Export` performs the read-only aggregation and
/// returns it in the response for the admin to deliver to the
/// volunteer; `Deletion` anonymizes the `Volunteer` aggregate in place
/// via `compliance_audit::complete_deletion` (never a physical row
/// delete, per compliance-audit.md's "Deletion invariant") and returns
/// no data.
pub async fn complete_request(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let id: DataSubjectRequestId = Id::from_uuid(id);
    let request_repo = SqlxDataSubjectRequestRepository;
    let mut tx = state.db.begin_scoped(admin_id.as_uuid()).await.map_err(|_| ApiError::Internal)?;

    let existing = request_repo.find_by_id(&mut tx, id).await.map_err(|_| ApiError::Internal)?.ok_or(ApiError::NotFound)?;
    if existing.status() != RequestStatus::InProgress {
        return Err(ApiError::BadRequest);
    }

    match existing.request_type() {
        RequestType::Deletion => {
            let volunteer_repo = SqlxVolunteerRepository;
            let events = complete_deletion(&mut tx, &request_repo, &volunteer_repo, id, admin_id)
                .await
                .map_err(|_| ApiError::Internal)?;
            record_audit_events(&mut tx, &events).await.map_err(|_| ApiError::Internal)?;
            record_outbox_events(&mut tx, &events).await.map_err(|_| ApiError::Internal)?;
            let completed = request_repo.find_by_id(&mut tx, id).await.map_err(|_| ApiError::Internal)?.ok_or(ApiError::Internal)?;
            tx.commit().await.map_err(|_| ApiError::Internal)?;

            Ok(Json(CompleteDataSubjectRequestResponse {
                request: DataSubjectRequestDto::from(&completed),
                export: None,
            }))
        }
        RequestType::Export => {
            let volunteer_repo = SqlxVolunteerRepository;
            let volunteer = volunteer_repo
                .find_by_id(&mut tx, existing.volunteer_id())
                .await
                .map_err(|_| ApiError::Internal)?
                .ok_or(ApiError::Internal)?;

            let assignment_repo = SqlxAssignmentRepository;
            let assignments = assignment_repo
                .find_by_volunteer(&mut tx, existing.volunteer_id())
                .await
                .map_err(|_| ApiError::Internal)?;

            let hour_entry_repo = SqlxHourEntryRepository;
            let hour_entries = hour_entry_repo
                .find_by_volunteer(&mut tx, existing.volunteer_id())
                .await
                .map_err(|_| ApiError::Internal)?;

            let export = VolunteerDataExportDto {
                volunteer: VolunteerExportDto {
                    id: volunteer.id().as_uuid(),
                    name: volunteer.name().to_string(),
                    email: volunteer.email().to_string(),
                    discord_id: volunteer.discord_id().map(str::to_string),
                    timezone: volunteer.timezone().to_string(),
                    skills: volunteer.skills().iter().map(|s| s.as_str().to_string()).collect(),
                    availability: volunteer.availability().0.clone(),
                    country_region: volunteer.country_region().map(str::to_string),
                    status: volunteer.status().as_str().to_string(),
                    role: volunteer.role().as_str().to_string(),
                    code_of_conduct_accepted_at: volunteer.agreements().code_of_conduct_accepted_at,
                    ip_agreement_accepted_at: volunteer.agreements().ip_agreement_accepted_at,
                    age_attestation_confirmed_at: volunteer.agreements().age_attestation_confirmed_at,
                    created_at: volunteer.created_at(),
                },
                assignments: assignments
                    .iter()
                    .map(|a| AssignmentExportDto {
                        id: a.id().as_uuid(),
                        project_id: a.project_id().as_uuid(),
                        role: a.role().to_string(),
                        participation_mode: a.participation_mode().as_str().to_string(),
                        status: a.status().as_str().to_string(),
                        applied_at: a.applied_at(),
                        decided_at: a.decided_at(),
                        attended_at: a.attended_at(),
                    })
                    .collect(),
                hour_entries: hour_entries
                    .iter()
                    .map(|h| HourEntryExportDto {
                        id: h.id().as_uuid(),
                        assignment_id: h.assignment_id().as_uuid(),
                        date: h.date(),
                        hours: h.hours().value().to_string(),
                        description: h.description().to_string(),
                        status: h.status().as_str().to_string(),
                        decided_at: h.decided_at(),
                    })
                    .collect(),
            };

            let mut request = existing;
            request.complete(admin_id, CompletionMethod::Exported).map_err(|_| ApiError::Internal)?;
            let events = request_repo.save(&mut tx, &mut request).await.map_err(|_| ApiError::Internal)?;
            record_audit_events(&mut tx, &events).await.map_err(|_| ApiError::Internal)?;
            record_outbox_events(&mut tx, &events).await.map_err(|_| ApiError::Internal)?;
            tx.commit().await.map_err(|_| ApiError::Internal)?;

            Ok(Json(CompleteDataSubjectRequestResponse {
                request: DataSubjectRequestDto::from(&request),
                export: Some(export),
            }))
        }
    }
}
