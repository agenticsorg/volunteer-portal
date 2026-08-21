//! Prompt 6.1 -- GET /volunteers/{volunteer_id}/verification-letter.
//! Self- or admin-triggered (concept.md section 5: "volunteer triggers
//! generation themselves"); the same self-or-admin shape as
//! `hours::volunteer_hours_total`, since a letter is scoped to one
//! volunteer's own record, not a lead's project.

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use chrono::{NaiveDate, Utc};
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

/// notifications.md trigger 5: the one event that breaks the "domain
/// event from an aggregate's repository save" pattern. There is no
/// `VerificationLetter` aggregate to hand back
/// `Vec<Box<dyn DomainEvent>>` from `save()` (hours-verification.md's
/// "Verification letters: a process, not a stored entity" -- there is
/// no `save()` at all), so this writes directly to
/// `domain_event_outbox`, in its own small transaction, immediately
/// after a successful render -- not via `kernel::record_outbox_events`,
/// which only ever runs against a repository's returned events. Carries
/// no state worth auditing beyond what `HoursApproved`/`HoursAdjusted`
/// already captured, so this is a plain outbox write, not an
/// `AuditableEvent` (contrast with every other outbox-sourced trigger).
async fn write_verification_letter_generated_event(
    state: &AppState,
    volunteer_id: VolunteerId,
    range: DateRange,
) -> Result<(), ApiError> {
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let payload = serde_json::json!({
        "volunteer_id": volunteer_id,
        "range_start": range.start.to_string(),
        "range_end": range.end.to_string(),
    });
    sqlx::query!(
        r#"insert into domain_event_outbox (event_type, payload, occurred_at)
           values ('verification_letter_ready', $1, $2)"#,
        payload,
        Utc::now(),
    )
    .execute(&mut *tx)
    .await
    .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;
    Ok(())
}

/// Streams the generated PDF bytes directly in the HTTP response --
/// never written to disk or object storage (ADR-0009's "rendered on
/// demand ... never stored"). A GET, but not fully side-effect-free as
/// of Prompt 7.1: it writes one `domain_event_outbox` row (trigger 5,
/// above) so Notifications can send a "your letter is ready" email --
/// `hour_entry`/`audit_log` remain untouched either way, which is what
/// "the letter itself is never persisted" actually means (see
/// `apps/api/tests/verification_letter.rs`'s side-effect assertions).
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

    write_verification_letter_generated_event(&state, volunteer_id, range).await?;

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
