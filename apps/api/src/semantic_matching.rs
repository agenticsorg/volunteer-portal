//! Prompt 9.1: the two suggestion endpoints backed by the isolated
//! semantic-matching service (ADR-0013). Every suggestion is re-checked
//! against RLS/authorization before being shown -- see each handler's
//! own doc comment for exactly how, and
//! `apps/api/tests/semantic_matching.rs` for the test that proves it.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::Json;
use identity_access::{SqlxVolunteerRepository, VolunteerRepository};
use kernel::{Id, ProjectId};
use projects_assignments::{
    AssignmentRepository, AssignmentStatus, ParticipationMode, ProjectRepository, ProjectStatus,
    SqlxAssignmentRepository, SqlxProjectRepository,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::semantic_matching_client::{Collection, MatchItem};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SuggestProjectsQuery {
    skills: String,
    limit: Option<usize>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "ProjectSuggestion.ts")]
pub struct ProjectSuggestionDto {
    pub project_id: Uuid,
    pub name: String,
    pub score: f64,
}

/// GET /projects/suggest?skills=... -- concept.md section 10's first
/// `ruvector` use case: free-text skills -> ranked open projects.
/// Deliberately does not touch `projects::list_open_projects`'s
/// deterministic SQL search at all (Prompt 9.1: "must remain fully
/// functional and unmodified") -- this is a wholly separate, additive
/// endpoint that simply fails with `ApiError::Internal` if the
/// semantic-matching service is unreachable, rather than the
/// deterministic search falling back to it (there is nothing to fall
/// back *from*; the two are independent).
///
/// The re-check: every id the service returns is looked up via
/// `ProjectRepository::find_by_id` under *this caller's own*
/// RLS-scoped transaction. `project_select`'s policy (`status = 'open'
/// OR admin OR is_lead_of_project`) means an unauthorized id (e.g. a
/// closed project this caller doesn't lead) resolves to `None` here and
/// is silently dropped -- this is what actually prevents the semantic
/// service (which holds no authorization context at all) from leaking
/// a suggestion the caller shouldn't see, per Prompt 9.1's explicit
/// leakage exit criterion.
pub async fn suggest_projects(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<SuggestProjectsQuery>,
) -> Result<Json<Vec<ProjectSuggestionDto>>, ApiError> {
    if query.skills.trim().is_empty() {
        return Err(ApiError::BadRequest);
    }
    let limit = query.limit.unwrap_or(10).clamp(1, 50);

    let matches = state
        .semantic_match
        .match_query(Collection::Projects, &query.skills, limit)
        .await
        .map_err(|_| ApiError::Internal)?;

    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let project_repo = SqlxProjectRepository;
    let mut suggestions = Vec::with_capacity(matches.len());
    for m in matches {
        let project_id: ProjectId = Id::from_uuid(m.id);
        let found = project_repo
            .find_by_id(&mut tx, project_id)
            .await
            .map_err(|_| ApiError::Internal)?;
        // `None` here means the authorization re-check dropped this
        // suggestion (see doc comment above) -- not an error.
        if let Some(project) = found {
            suggestions.push(ProjectSuggestionDto {
                project_id: project.id().as_uuid(),
                name: project.name().to_string(),
                score: m.score,
            });
        }
    }
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(suggestions))
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "HoursSuggestion.ts")]
pub struct HoursSuggestionDto {
    pub project_id: Uuid,
    pub project_name: String,
    pub score: f64,
}

/// GET /volunteers/me/hours-suggestions -- concept.md section 10's
/// second `ruvector` use case: "suggests which open project a returning
/// volunteer should log hours against." The candidate set is the
/// caller's own approved Contributor-mode assignments to still-open
/// projects (the exact eligibility `HourEntry::log` already enforces --
/// hours-verification.md's event-hours invariant), resolved via this
/// caller's own RLS-scoped transaction *before* the semantic service is
/// ever called. Unlike `suggest_projects` above, no separate re-check
/// step is needed afterward: `matchCandidates` on the service side can
/// only reorder/subset the candidates it was handed, never introduce an
/// id outside this caller's own already-authorized assignments.
pub async fn hours_suggestions(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<HoursSuggestionDto>>, ApiError> {
    let mut tx = state
        .db
        .begin_scoped(caller_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    let volunteer_repo = SqlxVolunteerRepository;
    let volunteer = volunteer_repo
        .find_by_id(&mut tx, caller_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Internal)?;
    let skills_text = volunteer
        .skills()
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    if skills_text.trim().is_empty() {
        tx.commit().await.map_err(|_| ApiError::Internal)?;
        return Ok(Json(Vec::new()));
    }

    let assignment_repo = SqlxAssignmentRepository;
    let assignments = assignment_repo
        .find_by_volunteer(&mut tx, caller_id)
        .await
        .map_err(|_| ApiError::Internal)?;

    let project_repo = SqlxProjectRepository;
    let mut candidates = Vec::new();
    let mut names = HashMap::new();
    for assignment in &assignments {
        if assignment.status() != AssignmentStatus::Approved
            || assignment.participation_mode() != ParticipationMode::Contributor
        {
            continue;
        }
        let Some(project) = project_repo
            .find_by_id(&mut tx, assignment.project_id())
            .await
            .map_err(|_| ApiError::Internal)?
        else {
            continue;
        };
        if project.status() != ProjectStatus::Open {
            continue;
        }
        names.insert(project.id().as_uuid(), project.name().to_string());
        candidates.push(MatchItem {
            id: project.id().as_uuid(),
            text: project.description().to_string(),
        });
    }
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    if candidates.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let candidate_count = candidates.len();
    let matches = state
        .semantic_match
        .match_candidates(&skills_text, &candidates, candidate_count)
        .await
        .map_err(|_| ApiError::Internal)?;

    Ok(Json(
        matches
            .into_iter()
            .filter_map(|m| {
                names.get(&m.id).map(|name| HoursSuggestionDto {
                    project_id: m.id,
                    project_name: name.clone(),
                    score: m.score,
                })
            })
            .collect(),
    ))
}
