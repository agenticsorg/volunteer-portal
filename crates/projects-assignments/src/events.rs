use chrono::{DateTime, Utc};
use kernel::{
    ActorId, AssignmentId, AuditAction, AuditEntityType, AuditableEvent, DomainEvent, OutboxEvent,
    ProjectId, VolunteerId,
};
use uuid::Uuid;

use crate::assignment::ParticipationMode;
use crate::project::ProjectType;

#[derive(Debug, Clone)]
pub struct ProjectCreated {
    pub project_id: ProjectId,
    pub name: String,
    pub project_type: ProjectType,
    pub initial_lead: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for ProjectCreated {
    fn event_type(&self) -> &'static str {
        "project_created"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for ProjectCreated {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.initial_lead)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Created
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Project
    }
    fn entity_id(&self) -> Uuid {
        self.project_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "name": self.name,
            "project_type": self.project_type.as_str(),
        }))
    }
}

#[derive(Debug, Clone)]
pub struct ProjectLeadAdded {
    pub project_id: ProjectId,
    pub volunteer_id: VolunteerId,
    /// The actor who performed the add -- deliberately distinct from
    /// `volunteer_id` (the lead being added), the same shape
    /// `ProjectClosed::closed_by` already uses. Prompt 8.2's audit-
    /// coverage suite caught this event previously reporting
    /// `volunteer_id` as its own `AuditableEvent::actor()`, which made
    /// `audit_log.actor_id` the *new lead*, not whoever added them --
    /// wrong in general, and a hard RLS failure specifically whenever
    /// the adding actor isn't the volunteer being added (i.e. every real
    /// admin/lead-performed add).
    pub added_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for ProjectLeadAdded {
    fn event_type(&self) -> &'static str {
        "project_lead_added"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for ProjectLeadAdded {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.added_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Project
    }
    fn entity_id(&self) -> Uuid {
        self.project_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "lead_added": self.volunteer_id.to_string() }))
    }
}

#[derive(Debug, Clone)]
pub struct ProjectLeadRemoved {
    pub project_id: ProjectId,
    pub volunteer_id: VolunteerId,
    /// The actor who performed the removal -- see
    /// `ProjectLeadAdded::added_by`'s doc comment; same bug, same fix.
    pub removed_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for ProjectLeadRemoved {
    fn event_type(&self) -> &'static str {
        "project_lead_removed"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for ProjectLeadRemoved {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.removed_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Project
    }
    fn entity_id(&self) -> Uuid {
        self.project_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "lead": self.volunteer_id.to_string() }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        None
    }
}

#[derive(Debug, Clone)]
pub struct ProjectClosed {
    pub project_id: ProjectId,
    pub closed_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for ProjectClosed {
    fn event_type(&self) -> &'static str {
        "project_closed"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for ProjectClosed {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.closed_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Project
    }
    fn entity_id(&self) -> Uuid {
        self.project_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "open" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "closed" }))
    }
}

#[derive(Debug, Clone)]
pub struct AssignmentApplied {
    pub assignment_id: AssignmentId,
    pub volunteer_id: VolunteerId,
    pub project_id: ProjectId,
    pub participation_mode: ParticipationMode,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for AssignmentApplied {
    fn event_type(&self) -> &'static str {
        "assignment_applied"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for AssignmentApplied {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.volunteer_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Created
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Assignment
    }
    fn entity_id(&self) -> Uuid {
        self.assignment_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "project_id": self.project_id.to_string(),
            "participation_mode": self.participation_mode.as_str(),
        }))
    }
}

#[derive(Debug, Clone)]
pub struct AssignmentApproved {
    pub assignment_id: AssignmentId,
    pub decided_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for AssignmentApproved {
    fn event_type(&self) -> &'static str {
        "assignment_approved"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
    fn as_outboxable(&self) -> Option<&dyn OutboxEvent> {
        Some(self)
    }
}

/// notifications.md trigger 2 (assignment approved) -- payload carries
/// only `assignment_id`/`decided_by`, not a recipient: this event
/// doesn't know the assigned volunteer's id at the type level (the
/// aggregate exposes it, but adding it here would duplicate what the
/// dispatcher's own `AssignmentRecipientQuery` port already resolves).
/// `decided_by` is the approving lead/admin, never the notification
/// recipient -- the dispatcher must not confuse the two.
impl OutboxEvent for AssignmentApproved {
    fn payload(&self) -> serde_json::Value {
        serde_json::json!({ "assignment_id": self.assignment_id, "decided_by": self.decided_by })
    }
}

impl AuditableEvent for AssignmentApproved {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.decided_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Assignment
    }
    fn entity_id(&self) -> Uuid {
        self.assignment_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "applied" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "approved" }))
    }
}

#[derive(Debug, Clone)]
pub struct AssignmentRemoved {
    pub assignment_id: AssignmentId,
    pub decided_by: VolunteerId,
    pub reason: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for AssignmentRemoved {
    fn event_type(&self) -> &'static str {
        "assignment_removed"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for AssignmentRemoved {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.decided_by)
    }
    // The row is soft-removed via `status`, not physically deleted, but
    // the audit-log action is `Deleted` in the compliance sense --
    // per projects-assignments.md's explicit framing.
    fn action(&self) -> AuditAction {
        AuditAction::Deleted
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Assignment
    }
    fn entity_id(&self) -> Uuid {
        self.assignment_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "applied_or_approved" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "removed", "reason": self.reason }))
    }
}
