use chrono::{DateTime, Utc};
use kernel::{DomainEvent, NotificationAttemptId, VolunteerId};

use crate::notification_attempt::TriggerType;

/// Neither this nor `NotificationFailed` implements `AuditableEvent` or
/// `OutboxEvent` -- notifications.md is explicit that delivery telemetry
/// ("did an email send succeed or fail") doesn't belong in `audit_log`
/// (compliance-audit.md deliberately declined to add a
/// `NotificationAttempt` `AuditEntityType` variant for exactly this
/// reason), and nothing downstream reacts to a notification having been
/// sent. These events exist for observability (the dispatcher logs
/// them) and to keep this context's "domain events it owns" list
/// complete per the DDD doc, not to feed either framework mechanism.
#[derive(Debug, Clone)]
pub struct NotificationSent {
    pub attempt_id: NotificationAttemptId,
    pub trigger_type: TriggerType,
    pub recipient: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for NotificationSent {
    fn event_type(&self) -> &'static str {
        "notification_sent"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
}

#[derive(Debug, Clone)]
pub struct NotificationFailed {
    pub attempt_id: NotificationAttemptId,
    pub trigger_type: TriggerType,
    pub recipient: VolunteerId,
    pub error: String,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for NotificationFailed {
    fn event_type(&self) -> &'static str {
        "notification_failed"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
}
