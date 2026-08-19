//! Prompt 3.3: project directory, apply flow, and lead roster management
//! (concept.md section 4). Event signup is the same apply flow against
//! an event-type project -- no special-casing needed, per the whole
//! point of projects-assignments.md's discriminator-column design.
//!
//! `LeadOf`'s extractor assumes exactly one dynamic path segment (a
//! single `Uuid`), so every lead-scoped route here carries only
//! `{project_id}` in its path; an `assignment_id` needed alongside it
//! travels in the request body instead. Lead-scoped handlers name both
//! `AuthUser` (to scope the transaction as the caller's own id) and
//! `LeadOf` (the authorization check) -- `LeadOf` proves lead membership
//! but doesn't surface the caller's id itself.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use identity_access::{Role, SqlxVolunteerSummaryQuery, VolunteerSummaryQuery};
use kernel::{record_audit_events, Id, ProjectId, Skill};
use projects_assignments::{
    Assignment, AssignmentRepository, EventSchedule, Project, ProjectRepository, ProjectType,
    SqlxAssignmentRepository, SqlxProjectRepository,
};
use serde::Deserialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::auth::{ensure_scoped_to, AuthUser, LeadOfOrAdmin};
use crate::dto::{AssignmentDto, ProjectSummaryDto};
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct DirectoryQuery {
    skill: Option<String>,
}

/// GET /projects?skill=... -- the deterministic SQL directory search
/// (find_open_by_skill), filterable by skill.
pub async fn list_open_projects(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<Vec<ProjectSummaryDto>>, ApiError> {
    let Some(skill) = query.skill else {
        return Err(ApiError::BadRequest);
    };
    let skill = Skill::new(skill).map_err(|_| ApiError::BadRequest)?;

    let repo = SqlxProjectRepository;
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let summaries = repo
        .find_open_by_skill(&mut tx, &skill)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(summaries.into_iter().map(Into::into).collect()))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "CreateProjectRequest.ts")]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: String,
    pub is_event: bool,
    pub needed_skills: Vec<String>,
    /// Required (and only meaningful) when `is_event` is true, per
    /// projects-assignments.md invariant 5.
    pub next_occurrence_at: Option<chrono::DateTime<chrono::Utc>>,
    pub recurrence_note: Option<String>,
}

/// POST /projects -- the caller becomes the project's initial lead.
/// Requires Lead or Admin role (matches the `project_insert` RLS
/// policy's own `current_actor_role() in ('lead', 'admin')` check,
/// enforced here too so a non-lead gets a clean 403 rather than a raw
/// RLS-denied database error surfacing as a 500).
pub async fn create_project(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let summary_query = SqlxVolunteerSummaryQuery;
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let summary = summary_query
        .summary(&mut tx, volunteer_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Unauthorized)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    if !matches!(summary.role, Role::Lead | Role::Admin) {
        return Err(ApiError::Forbidden);
    }

    let project_type = if payload.is_event {
        ProjectType::Event
    } else {
        ProjectType::Project
    };
    let schedule = if payload.is_event {
        Some(EventSchedule {
            next_occurrence_at: payload.next_occurrence_at.ok_or(ApiError::BadRequest)?,
            recurrence_note: payload.recurrence_note,
        })
    } else {
        None
    };
    let needed_skills: Vec<Skill> = payload
        .needed_skills
        .into_iter()
        .filter_map(|s| Skill::new(s).ok())
        .collect();

    let mut project = Project::create(
        payload.name,
        payload.description,
        project_type,
        needed_skills,
        volunteer_id,
        schedule,
    )
    .map_err(|_| ApiError::BadRequest)?;

    let repo = SqlxProjectRepository;
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let events = repo
        .save(&mut tx, &mut project)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok((StatusCode::CREATED, Json(project.id().to_string())))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "ApplyToProjectRequest.ts")]
pub struct ApplyToProjectRequest {
    pub role: String,
}

/// POST /projects/{project_id}/apply -- always self-initiated (the
/// caller applies as themselves; there is no path for a lead to apply
/// on someone else's behalf).
pub async fn apply_to_project(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<ApplyToProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id: ProjectId = Id::from_uuid(project_id);
    let project_repo = SqlxProjectRepository;
    let assignment_repo = SqlxAssignmentRepository;

    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let project = project_repo
        .find_by_id(&mut tx, project_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    let mut assignment =
        Assignment::apply(&project, volunteer_id, payload.role).map_err(|_| ApiError::BadRequest)?;
    let events = assignment_repo
        .save(&mut tx, &mut assignment)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok((StatusCode::CREATED, Json(assignment.id().to_string())))
}

/// GET /projects/{project_id}/roster -- applicants and current roster,
/// lead- or admin-scoped view (concept.md sections 2 and 4).
pub async fn get_roster(
    AuthUser(caller_id): AuthUser,
    LeadOfOrAdmin(project_id): LeadOfOrAdmin,
    State(state): State<AppState>,
) -> Result<Json<Vec<AssignmentDto>>, ApiError> {
    let repo = SqlxAssignmentRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let assignments = repo
        .find_by_project(&mut tx, project_id)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(assignments.into_iter().map(Into::into).collect()))
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "AssignmentActionRequest.ts")]
pub struct AssignmentActionRequest {
    pub assignment_id: Uuid,
    /// Only meaningful for the remove action.
    pub reason: Option<String>,
}

/// POST /projects/{project_id}/assignments/approve
pub async fn approve_assignment(
    AuthUser(caller_id): AuthUser,
    LeadOfOrAdmin(project_id): LeadOfOrAdmin,
    State(state): State<AppState>,
    Json(payload): Json<AssignmentActionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let repo = SqlxAssignmentRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut assignment = repo
        .find_by_id(&mut tx, Id::from_uuid(payload.assignment_id))
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    // `LeadOfOrAdmin` already proved caller_id is authorized against the
    // *path* project; this only makes sense if the assignment actually
    // belongs to that project too (a crafted assignment_id from a
    // different project must not be approvable just because the caller
    // leads, or has admin scope over, some *other* project's action).
    ensure_scoped_to(assignment.project_id(), project_id)?;

    assignment
        .approve(caller_id, true)
        .map_err(|_| ApiError::BadRequest)?;

    let events = repo
        .save(&mut tx, &mut assignment)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /projects/{project_id}/assignments/remove -- also the mechanism
/// behind "remove and reassign" (concept.md section 4): a reassignment
/// is this remove call followed by a normal `apply_to_project` call for
/// the new project/role, per projects-assignments.md's explicit
/// "two discrete events, not an in-place edit" design.
pub async fn remove_assignment(
    AuthUser(caller_id): AuthUser,
    LeadOfOrAdmin(project_id): LeadOfOrAdmin,
    State(state): State<AppState>,
    Json(payload): Json<AssignmentActionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let repo = SqlxAssignmentRepository;
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut assignment = repo
        .find_by_id(&mut tx, Id::from_uuid(payload.assignment_id))
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    ensure_scoped_to(assignment.project_id(), project_id)?;

    assignment
        .remove(caller_id, true, payload.reason)
        .map_err(|_| ApiError::BadRequest)?;

    let events = repo
        .save(&mut tx, &mut assignment)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}
