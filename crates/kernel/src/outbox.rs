use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::error::RepoError;
use crate::events::DomainEvent;

/// The framework-level outbox write (context-map.md mechanism "b").
/// Sibling to `record_audit_events`, called alongside it at the same
/// call sites: every repository's `save()` returns `Vec<Box<dyn
/// DomainEvent>>`, and every event that implements `OutboxEvent`
/// (checked via `DomainEvent::as_outboxable`) is written to
/// `domain_event_outbox`, in the same transaction as the aggregate
/// save. This is the **only** sanctioned way `domain_event_outbox` is
/// ever written to from a repository-backed mutation -- the one
/// documented exception is `VerificationLetterGenerated`
/// (`apps/api/src/verification_letter.rs`), which has no aggregate save
/// to piggyback on and writes directly, per notifications.md.
pub async fn record_outbox_events(
    tx: &mut Transaction<'_, Postgres>,
    events: &[Box<dyn DomainEvent>],
) -> Result<usize, RepoError> {
    let mut written = 0usize;
    for event in events {
        let Some(outboxable) = event.as_outboxable() else {
            continue;
        };
        sqlx::query!(
            r#"insert into domain_event_outbox (event_type, payload, occurred_at)
               values ($1, $2, $3)"#,
            outboxable.event_type(),
            outboxable.payload(),
            outboxable.occurred_at(),
        )
        .execute(&mut **tx)
        .await?;
        written += 1;
    }
    Ok(written)
}

/// One unprocessed (or previously-failed-and-retried) row read back off
/// `domain_event_outbox` -- the generic shape a poller (today,
/// Notifications' dispatcher) works from, regardless of which context
/// originally wrote it.
#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub id: Uuid,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub occurred_at: DateTime<Utc>,
    pub attempts: i32,
}

/// Generic poll/mark-processed machinery over `domain_event_outbox` --
/// deliberately kernel-level, not owned by any one bounded context
/// (context-map.md mechanism "b" names both Notifications and a future
/// Discord Integration debounce trigger as potential pollers of the same
/// table). A poller's *dispatch* logic (deciding what an `event_type`
/// means and what to do about it) lives in the consuming crate, not
/// here.
#[async_trait]
pub trait OutboxRepository: Send + Sync {
    /// At-least-once by design (context-map.md): a row already marked
    /// `processed_at` is excluded, but nothing here guarantees
    /// exactly-once dispatch of a given row -- consumers are expected to
    /// be idempotent on `(event_type, ...)`, per notifications.md's own
    /// `exists_for_source_event` check.
    async fn poll_unprocessed(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        limit: i64,
    ) -> Result<Vec<OutboxRow>, RepoError>;

    async fn mark_processed(&self, tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), RepoError>;

    /// Called when a poller gives up on a row for this tick (e.g. every
    /// recipient resolution failed) without marking it processed, so the
    /// next tick can distinguish "never attempted" rows from "attempted
    /// N times and still pending" ones -- purely observational, nothing
    /// in this crate acts on the count (no max-attempts cutoff is
    /// specified anywhere in the DDD docs, so none is invented here).
    async fn increment_attempts(&self, tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), RepoError>;
}

pub struct SqlxOutboxRepository;

#[async_trait]
impl OutboxRepository for SqlxOutboxRepository {
    async fn poll_unprocessed(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        limit: i64,
    ) -> Result<Vec<OutboxRow>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, event_type, payload, occurred_at as "occurred_at: DateTime<Utc>", attempts
               from domain_event_outbox
               where processed_at is null
               order by occurred_at asc
               limit $1"#,
            limit,
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| OutboxRow {
                id: r.id,
                event_type: r.event_type,
                payload: r.payload,
                occurred_at: r.occurred_at,
                attempts: r.attempts,
            })
            .collect())
    }

    async fn mark_processed(&self, tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), RepoError> {
        sqlx::query!(
            r#"update domain_event_outbox set processed_at = now() where id = $1"#,
            id,
        )
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    async fn increment_attempts(&self, tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), RepoError> {
        sqlx::query!(
            r#"update domain_event_outbox set attempts = attempts + 1 where id = $1"#,
            id,
        )
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
}
