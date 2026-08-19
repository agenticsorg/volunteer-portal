use chrono::{DateTime, NaiveDate, Utc};
use kernel::{
    ActorId, AuditAction, AuditEntityType, AuditableEvent, DomainEvent, HourEntryId, VolunteerId,
};
use uuid::Uuid;

use crate::hours::Hours;

#[derive(Debug, Clone)]
pub struct HoursLogged {
    pub hour_entry_id: HourEntryId,
    pub assignment_id: kernel::AssignmentId,
    pub volunteer_id: VolunteerId,
    pub hours: Hours,
    pub date: NaiveDate,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for HoursLogged {
    fn event_type(&self) -> &'static str {
        "hours_logged"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for HoursLogged {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.volunteer_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Created
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::HourEntry
    }
    fn entity_id(&self) -> Uuid {
        self.hour_entry_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "hours": self.hours.value(), "date": self.date, "status": "pending" }))
    }
}

#[derive(Debug, Clone)]
pub struct HoursApproved {
    pub hour_entry_id: HourEntryId,
    pub approver_id: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for HoursApproved {
    fn event_type(&self) -> &'static str {
        "hours_approved"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for HoursApproved {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.approver_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::HourApproved
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::HourEntry
    }
    fn entity_id(&self) -> Uuid {
        self.hour_entry_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "pending" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "approved" }))
    }
}

#[derive(Debug, Clone)]
pub struct HoursRejected {
    pub hour_entry_id: HourEntryId,
    pub approver_id: VolunteerId,
    pub reason: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for HoursRejected {
    fn event_type(&self) -> &'static str {
        "hours_rejected"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for HoursRejected {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.approver_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::HourRejected
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::HourEntry
    }
    fn entity_id(&self) -> Uuid {
        self.hour_entry_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "pending" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "rejected", "reason": self.reason }))
    }
}

/// The event `concept.md` section 8's "visible audit trail" requirement is
/// actually about -- carries explicit before/after `Hours` values rather
/// than a generic diff, since `Hours` is the one field that matters here
/// (hours-verification.md).
#[derive(Debug, Clone)]
pub struct HoursAdjusted {
    pub hour_entry_id: HourEntryId,
    pub adjusted_by: VolunteerId,
    pub previous_hours: Hours,
    pub new_hours: Hours,
    pub reason: String,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for HoursAdjusted {
    fn event_type(&self) -> &'static str {
        "hours_adjusted"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for HoursAdjusted {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.adjusted_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::HourAdjusted
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::HourEntry
    }
    fn entity_id(&self) -> Uuid {
        self.hour_entry_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "hours": self.previous_hours.value() }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "hours": self.new_hours.value(), "reason": self.reason }))
    }
}
