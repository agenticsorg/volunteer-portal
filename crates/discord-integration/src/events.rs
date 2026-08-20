use chrono::{DateTime, Utc};
use kernel::DomainEvent;
use uuid::Uuid;

/// A routine reconcile run, even one that made corrections, is an
/// operational/system event, not an admin action or a change to a
/// person's own data in the sense `audit_log`'s `actor_id`/`entity_type`
/// model captures -- deliberately **not** `AuditableEvent`
/// (discord-integration.md). Logged to `reconcile_run_log` instead (see
/// `repository.rs`).
#[derive(Debug, Clone)]
pub struct DiscordRoleReconciled {
    pub run_id: Uuid,
    pub desynced_count: usize,
    pub corrected_count: usize,
    pub ran_at: DateTime<Utc>,
}

impl DomainEvent for DiscordRoleReconciled {
    fn event_type(&self) -> &'static str {
        "discord_role_reconciled"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.ran_at
    }
    // Uses the default `as_auditable` -> `None`: not an AuditableEvent.
}
