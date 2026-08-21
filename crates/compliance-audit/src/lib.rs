//! Compliance & Audit bounded context. See `.plans/ddd/compliance-audit.md`.
//! Implements Prompt 10.2's `DataSubjectRequest` aggregate, lifecycle,
//! and the anonymization orchestration service. The read side of
//! `AuditLog` (this file's module doc: "the query/read API over
//! `audit_log`") is not implemented here -- no consumer needs it yet
//! (admin reporting, Prompt 8.1, queries `hour_entry`/`volunteer`
//! directly, not `audit_log`), and this crate does not speculatively
//! build a port with no caller.
//!
//! The `Export` path's data pull (across `identity-access`,
//! `projects-assignments`, `hours-verification`) lives at `apps/api`'s
//! composition root, not here -- this crate depends on `kernel` and
//! `identity-access` only, matching every other context's dependency
//! shape (context-map.md's acyclic graph), so it cannot itself reach
//! into `projects-assignments`/`hours-verification`.

mod events;
mod repository;
mod request;
mod service;

pub use events::{CompletionMethod, DataSubjectRequestCompleted, DataSubjectRequestReceived};
pub use repository::{DataSubjectRequestRepository, SqlxDataSubjectRequestRepository};
pub use request::{DataSubjectRequest, DataSubjectRequestError, RequestStatus, RequestType};
pub use service::{complete_deletion, CompleteDeletionError};
