//! Prompt 6.1 -- GET /volunteers/{volunteer_id}/verification-letter.
//! Self- or admin-triggered (concept.md section 5: "volunteer triggers
//! generation themselves"); the same self-or-admin shape as
//! `hours::volunteer_hours_total`, since a letter is scoped to one
//! volunteer's own record, not a lead's project.

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use chrono::NaiveDate;
use hours_verification::{
    DateRange, SqlxHourEntryRepository, VerificationLetterError, VerificationLetterService,
};
use identity_access::{Role, SqlxVolunteerSummaryQuery, VolunteerSummaryQuery};
use kernel::{Id, VolunteerId};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::state::AppState;
use crate::verification_letter_render::render_verification_letter_pdf;

#[derive(Debug, Deserialize)]
pub struct VerificationLetterQuery {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

/// Streams the generated PDF bytes directly in the HTTP response --
/// never written to disk or object storage (ADR-0009's "rendered on
/// demand ... never stored"). A GET, deliberately: this is a read over
/// already-approved data, so it produces no domain event and no
/// `audit_log` row -- generating a letter twice from the same underlying
/// hours is a provably side-effect-free operation.
pub async fn generate_verification_letter(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    Path(volunteer_id): Path<Uuid>,
    Query(query): Query<VerificationLetterQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let volunteer_id: VolunteerId = Id::from_uuid(volunteer_id);
    if query.start > query.end {
        return Err(ApiError::BadRequest);
    }

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

    let hour_entries = SqlxHourEntryRepository;
    let volunteers = SqlxVolunteerSummaryQuery;
    let service = VerificationLetterService::new(
        &hour_entries,
        state.assignment_snapshot.as_ref(),
        state.project_names.as_ref(),
        &volunteers,
    );

    let range = DateRange {
        start: query.start,
        end: query.end,
    };
    let draft = service
        .draft(&mut tx, volunteer_id, range)
        .await
        .map_err(|err| match err {
            VerificationLetterError::VolunteerNotFound => ApiError::NotFound,
            VerificationLetterError::AssignmentNotFound
            | VerificationLetterError::ProjectNotFound
            | VerificationLetterError::Repo(_) => ApiError::Internal,
        })?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    let pdf_bytes = render_verification_letter_pdf(&draft).map_err(|_| ApiError::Internal)?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/pdf".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"verification-letter-{}-to-{}.pdf\"",
                    draft.range.start, draft.range.end
                ),
            ),
        ],
        pdf_bytes,
    ))
}
