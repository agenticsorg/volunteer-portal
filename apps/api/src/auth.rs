use axum::extract::{FromRequestParts, Path};
use axum::http::request::Parts;
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
/// (`projects-assignments`'s `project_lead` table once Prompt 3.2 wires
/// the real implementation — see `state::StubLeadMembershipQuery` until
/// then). Composes on top of `AuthUser` rather than duplicating session
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
