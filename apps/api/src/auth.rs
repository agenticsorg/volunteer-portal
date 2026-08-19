use axum::extract::{FromRequestParts, Path};
use axum::http::request::Parts;
use identity_access::{Role, SqlxVolunteerSummaryQuery, VolunteerSummaryQuery};
use kernel::{Id, ProjectId, VolunteerId};
use tower_sessions::Session;
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

/// Key under which the authenticated volunteer's id is stored in the
/// session (per identity-access.md: session is infrastructure, not a
/// domain aggregate — it holds nothing but this one identifier, and
/// everything downstream operates in terms of `VolunteerId`/`Role`).
pub const SESSION_VOLUNTEER_ID_KEY: &str = "volunteer_id";

/// Per ADR-0002: every mutating/admin handler names this (or `LeadOf`,
/// which itself requires it) in its function signature. There is no
/// framework middleware that gates access to routes by pattern — a
/// missing extractor is visible in the handler's own signature, not
/// buried in a separate registration file.
pub struct AuthUser(pub VolunteerId);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let session = Session::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::Unauthorized)?;
        let id: Option<Uuid> = session
            .get(SESSION_VOLUNTEER_ID_KEY)
            .await
            .map_err(|_| ApiError::Internal)?;
        let id = id.ok_or(ApiError::Unauthorized)?;
        Ok(AuthUser(Id::from_uuid(id)))
    }
}

/// Requires `AuthUser` and re-checks lead membership against the
/// `project_id` path parameter via `LeadMembershipQuery`
/// (`projects-assignments`'s real `project_lead`-table-backed
/// implementation, `SqlxProjectRepository`, wired in Prompt 3.1).
/// Composes on top of `AuthUser` rather than duplicating session
/// resolution, per ADR-0002's "extractors compose" design.
pub struct LeadOf(pub ProjectId);

impl FromRequestParts<AppState> for LeadOf {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(volunteer_id) = AuthUser::from_request_parts(parts, state).await?;
        let Path(project_id) = Path::<Uuid>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::BadRequest)?;
        let project_id: ProjectId = Id::from_uuid(project_id);

        let mut tx = state
            .db
            .begin_scoped(volunteer_id.as_uuid())
            .await
            .map_err(|_| ApiError::Internal)?;
        let is_lead = state
            .lead_membership
            .is_lead_of_project(&mut tx, volunteer_id, project_id)
            .await
            .map_err(|_| ApiError::Internal)?;
        tx.commit().await.map_err(|_| ApiError::Internal)?;

        if !is_lead {
            return Err(ApiError::Forbidden);
        }
        Ok(LeadOf(project_id))
    }
}

/// Requires `AuthUser` and re-checks the caller's `Role` is `Admin` via
/// `VolunteerSummaryQuery` — identity-access.md's invariant 3 keeps
/// coarse-grained role a single, explicit fact on `Volunteer` itself
/// (never inferred from project-level lead membership), so this is a
/// direct role check, not a `LeadOf`-style delegated query.
pub struct AdminUser(pub VolunteerId);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(volunteer_id) = AuthUser::from_request_parts(parts, state).await?;

        let query = SqlxVolunteerSummaryQuery;
        let mut tx = state
            .db
            .begin_scoped(volunteer_id.as_uuid())
            .await
            .map_err(|_| ApiError::Internal)?;
        let summary = query
            .summary(&mut tx, volunteer_id)
            .await
            .map_err(|_| ApiError::Internal)?
            .ok_or(ApiError::Unauthorized)?;
        tx.commit().await.map_err(|_| ApiError::Internal)?;

        if summary.role != Role::Admin {
            return Err(ApiError::Forbidden);
        }
        Ok(AdminUser(volunteer_id))
    }
}

/// Composes `AuthUser` with "`LeadOf` this path's project, OR `AdminUser`
/// (global scope)" — concept.md section 2's "Admins have global scope"
/// combined with a project-scoped action. This is the same admin-or-lead
/// shape the `assignment_select`/`assignment_update` RLS policies already
/// encode at the database layer (Prompt 1.2), and the shape
/// hours-verification.md specifies verbatim for hour-entry approval ("a
/// lead of the entry's project... or an admin (global scope)"). `LeadOf`
/// alone under-authorizes relative to both of those: an admin who isn't
/// personally a `project_lead` row would otherwise be refused. Every
/// project-scoped lead action should use this rather than bare `LeadOf`,
/// unless a prompt has an explicit reason an admin must NOT be able to
/// act (none currently do).
pub struct LeadOfOrAdmin(pub ProjectId);

impl FromRequestParts<AppState> for LeadOfOrAdmin {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(volunteer_id) = AuthUser::from_request_parts(parts, state).await?;
        let Path(project_id) = Path::<Uuid>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::BadRequest)?;
        let project_id: ProjectId = Id::from_uuid(project_id);

        let mut tx = state
            .db
            .begin_scoped(volunteer_id.as_uuid())
            .await
            .map_err(|_| ApiError::Internal)?;
        let is_lead = state
            .lead_membership
            .is_lead_of_project(&mut tx, volunteer_id, project_id)
            .await
            .map_err(|_| ApiError::Internal)?;
        let is_admin = if is_lead {
            false
        } else {
            let query = SqlxVolunteerSummaryQuery;
            query
                .summary(&mut tx, volunteer_id)
                .await
                .map_err(|_| ApiError::Internal)?
                .is_some_and(|s| s.role == Role::Admin)
        };
        tx.commit().await.map_err(|_| ApiError::Internal)?;

        if !is_lead && !is_admin {
            return Err(ApiError::Forbidden);
        }
        Ok(LeadOfOrAdmin(project_id))
    }
}

/// Defense-in-depth cross-check for a handler that authorizes against one
/// path-carried id (via `LeadOf`/`LeadOfOrAdmin`) but then loads a second
/// resource by an id carried in the request body (per `LeadOf`'s
/// single-dynamic-segment limitation): confirms the loaded resource
/// actually belongs to the authorized scope, so a crafted body id from a
/// *different* project the caller doesn't lead can't be acted on just
/// because the caller leads *some* project. Independently, RLS's own
/// scoping already blocks most such reads at the row level (`find_by_id`
/// simply returns `None`), but this check is what turns that into a clean
/// `BadRequest` rather than leaning on an RLS-driven `NotFound` to
/// accidentally do the right thing.
pub fn ensure_scoped_to(loaded: ProjectId, authorized: ProjectId) -> Result<(), ApiError> {
    if loaded != authorized {
        return Err(ApiError::BadRequest);
    }
    Ok(())
}
