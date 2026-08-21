use chrono::{DateTime, Utc};
use kernel::{ActorId, AuditAction, AuditEntityType, AuditableEvent, DataSubjectRequestId, DomainEvent, VolunteerId};
use uuid::Uuid;

use crate::request::RequestType;

/// `CompletionMethod::Anonymized` corresponds to `RequestType::Deletion`,
/// `Exported` to `RequestType::Export` -- a separate enum rather than
/// reusing `RequestType` because "how a request was resolved" and "what
/// kind of request it was" happen to align 1:1 today but are
/// conceptually distinct questions (compliance-audit.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionMethod {
    Anonymized,
    Exported,
}

impl CompletionMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            CompletionMethod::Anonymized => "anonymized",
            CompletionMethod::Exported => "exported",
        }
    }
}

/// Self-action (the actor *is* the requesting volunteer), same shape as
/// identity-access's `VolunteerOnboarded` -- still `AuditableEvent` for
/// compliance completeness: a record of who asked for their data, and
/// when, is itself compliance evidence.
#[derive(Debug, Clone)]
pub struct DataSubjectRequestReceived {
    pub request_id: DataSubjectRequestId,
    pub volunteer_id: VolunteerId,
    pub request_type: RequestType,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for DataSubjectRequestReceived {
    fn event_type(&self) -> &'static str {
        "data_subject_request_received"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for DataSubjectRequestReceived {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.volunteer_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Created
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::DataSubjectRequest
    }
    fn entity_id(&self) -> Uuid {
        self.request_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "volunteer_id": self.volunteer_id,
            "request_type": self.request_type.as_str(),
            "status": "received",
        }))
    }
}

/// Emitted by `DataSubjectRequest::complete`. Arguably the single most
/// important row type in `audit_log` for a PIPEDA/GDPR audit -- a record
/// of who resolved an erasure/export request, how, and when
/// (compliance-audit.md).
#[derive(Debug, Clone)]
pub struct DataSubjectRequestCompleted {
    pub request_id: DataSubjectRequestId,
    pub handled_by: VolunteerId,
    pub method: CompletionMethod,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for DataSubjectRequestCompleted {
    fn event_type(&self) -> &'static str {
        "data_subject_request_completed"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for DataSubjectRequestCompleted {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.handled_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::DataSubjectRequest
    }
    fn entity_id(&self) -> Uuid {
        self.request_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "in_progress" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "completed", "method": self.method.as_str() }))
    }
}
