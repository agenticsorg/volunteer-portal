use chrono::{DateTime, Utc};
use kernel::{ActorId, AuditAction, AuditEntityType, AuditableEvent, DomainEvent, ProjectId, VolunteerId};
use uuid::Uuid;

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
        ActorId::Volunteer(self.volunteer_id)
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
        ActorId::Volunteer(self.volunteer_id)
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
