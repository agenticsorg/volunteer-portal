//! Two read ports resolving "who gets notified, and with what context",
//! for the two triggers whose outbox payload carries only an id
//! (`assignment_id`/`hour_entry_id`), not a recipient -- per
//! `AssignmentApproved`/`HoursApproved`'s own `OutboxEvent::payload()`
//! doc comments. Defined here (not consumed from `projects-assignments`/
//! `hours-verification` directly) because those two crates and
//! `notifications` are siblings under `identity-access`
//! (context-map.md's acyclic dependency graph) -- implemented in
//! `apps/api`, the same adapter shape as
//! `hours_verification::AssignmentSnapshotQuery`.

use async_trait::async_trait;
use chrono::NaiveDate;
use kernel::{RepoError, VolunteerId};
use rust_decimal::Decimal;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentRecipient {
    pub volunteer_id: VolunteerId,
    pub project_name: String,
}

#[async_trait]
pub trait AssignmentRecipientQuery: Send + Sync {
    async fn recipient_for_assignment(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        assignment_id: Uuid,
    ) -> Result<Option<AssignmentRecipient>, RepoError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HourEntryRecipient {
    pub volunteer_id: VolunteerId,
    pub hours: Decimal,
    pub date: NaiveDate,
}

#[async_trait]
pub trait HourEntryRecipientQuery: Send + Sync {
    async fn recipient_for_hour_entry(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        hour_entry_id: Uuid,
    ) -> Result<Option<HourEntryRecipient>, RepoError>;
}
