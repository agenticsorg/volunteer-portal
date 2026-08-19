use sqlx::{Postgres, Transaction};

use crate::error::RepoError;
use crate::events::{ActorId, DomainEvent};

/// The framework-level audit write (ADR-0005 / context-map.md mechanism
/// "a"). Every repository's `save()` returns `Vec<Box<dyn DomainEvent>>`;
/// a handler calls this exactly once, in the same transaction as the
/// aggregate save, and every event that implements `AuditableEvent`
/// (checked via `DomainEvent::as_auditable`) is written to `audit_log`.
/// This is the **only** sanctioned way `audit_log` is ever written —
/// no handler in any crate should ever issue its own
/// `insert into audit_log` statement.
pub async fn record_audit_events(
    tx: &mut Transaction<'_, Postgres>,
    events: &[Box<dyn DomainEvent>],
) -> Result<usize, RepoError> {
    let mut written = 0usize;
    for event in events {
        let Some(auditable) = event.as_auditable() else {
            continue;
        };
        let actor_id = match auditable.actor() {
            ActorId::Volunteer(id) => Some(id.as_uuid()),
            ActorId::System => None,
        };
        sqlx::query!(
            r#"insert into audit_log (actor_id, action, entity_type, entity_id, before, after)
               values ($1, $2, $3, $4, $5, $6)"#,
            actor_id,
            auditable.action().as_str(),
            auditable.entity_type().as_str(),
            auditable.entity_id(),
            auditable.before(),
            auditable.after(),
        )
        .execute(&mut **tx)
        .await?;
        written += 1;
    }
    Ok(written)
}
