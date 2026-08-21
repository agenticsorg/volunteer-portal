//! The one piece of orchestration compliance-audit.md places inside this
//! context rather than at `apps/api`'s composition root: "this context's
//! `DataSubjectRequest` application service calls identity-access's
//! repository/command surface to perform the anonymization, then records
//! its own `DataSubjectRequestCompleted` alongside it." Permitted because
//! `compliance-audit -> identity-access` is a one-directional dependency
//! context-map.md's acyclic graph allows (unlike e.g.
//! `projects-assignments`/`hours-verification`, which are siblings that
//! must not depend on each other).
//!
//! The `Export` path has no equivalent here: it needs
//! `projects-assignments`/`hours-verification` data too, which this
//! crate deliberately does not depend on (compliance-audit.md's stated
//! dependency shape), so that aggregation happens at `apps/api` instead.

use identity_access::VolunteerRepository;
use kernel::{DataSubjectRequestId, DomainEvent, RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::events::CompletionMethod;
use crate::repository::DataSubjectRequestRepository;
use crate::request::DataSubjectRequestError;

#[derive(Debug, thiserror::Error)]
pub enum CompleteDeletionError {
    #[error("data subject request not found")]
    RequestNotFound,
    #[error("volunteer not found")]
    VolunteerNotFound,
    #[error(transparent)]
    Request(#[from] DataSubjectRequestError),
    #[error(transparent)]
    Repo(#[from] RepoError),
}

/// Completes a `Deletion`-type `DataSubjectRequest`: loads the target
/// `Volunteer`, anonymizes it in place (`Volunteer::anonymize`, never a
/// physical row delete, per compliance-audit.md's "Deletion invariant"),
/// saves both aggregates, and returns the combined event list (a
/// `VolunteerAnonymized` plus a `DataSubjectRequestCompleted`) for the
/// caller to hand to `kernel::record_audit_events`/`record_outbox_events`
/// exactly once, in the same transaction, alongside every other mutation
/// in this codebase. Requires the request to already be `InProgress`
/// (`DataSubjectRequest::complete`'s own invariant) -- the caller's
/// `AdminUser` extractor has already verified `handled_by` is an admin.
pub async fn complete_deletion(
    tx: &mut Transaction<'_, Postgres>,
    request_repo: &dyn DataSubjectRequestRepository,
    volunteer_repo: &dyn VolunteerRepository,
    request_id: DataSubjectRequestId,
    handled_by: VolunteerId,
) -> Result<Vec<Box<dyn DomainEvent>>, CompleteDeletionError> {
    let mut request = request_repo
        .find_by_id(tx, request_id)
        .await?
        .ok_or(CompleteDeletionError::RequestNotFound)?;

    let volunteer = volunteer_repo
        .find_by_id(tx, request.volunteer_id())
        .await?
        .ok_or(CompleteDeletionError::VolunteerNotFound)?;

    let mut anonymized = volunteer.anonymize(request_id, handled_by);
    let mut volunteer_events = volunteer_repo.save(tx, &mut anonymized).await?;

    request.complete(handled_by, CompletionMethod::Anonymized)?;
    let request_events = request_repo.save(tx, &mut request).await?;

    volunteer_events.extend(request_events);
    Ok(volunteer_events)
}
