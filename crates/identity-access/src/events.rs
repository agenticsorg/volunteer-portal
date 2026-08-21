use chrono::{DateTime, Utc};
use kernel::{
    ActorId, AuditAction, AuditEntityType, AuditableEvent, DataSubjectRequestId, DomainEvent, OutboxEvent,
    VolunteerId,
};
use uuid::Uuid;

use crate::oauth::OAuthProvider;
use crate::volunteer::Role;

/// Emitted on signup. Self-action (the actor *is* the new volunteer,
/// acting on their own not-yet-existing record) but still `AuditableEvent`
/// for compliance completeness, per identity-access.md.
#[derive(Debug, Clone)]
pub struct VolunteerOnboarded {
    pub volunteer_id: VolunteerId,
    pub name: String,
    pub email: String,
    pub provider: OAuthProvider,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for VolunteerOnboarded {
    fn event_type(&self) -> &'static str {
        "volunteer_onboarded"
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

/// notifications.md trigger 1 (signup confirmation) -- payload carries
/// `name`/`email` directly since the emitting `Volunteer::signup` call
/// already has both in hand; the dispatcher still independently resolves
/// the live `VolunteerContact` at send time rather than trusting this
/// payload's copy (a volunteer could change their email between signup
/// and the poller's next tick).
impl OutboxEvent for VolunteerOnboarded {
    fn payload(&self) -> serde_json::Value {
        serde_json::json!({ "volunteer_id": self.volunteer_id, "name": self.name, "email": self.email })
    }
}

impl AuditableEvent for VolunteerOnboarded {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.volunteer_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Created
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Volunteer
    }
    fn entity_id(&self) -> Uuid {
        self.volunteer_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "name": self.name,
            "email": self.email,
            "provider": self.provider.as_str(),
        }))
    }
}

#[derive(Debug, Clone)]
pub struct VolunteerApproved {
    pub volunteer_id: VolunteerId,
    pub approved_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for VolunteerApproved {
    fn event_type(&self) -> &'static str {
        "volunteer_approved"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for VolunteerApproved {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.approved_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Volunteer
    }
    fn entity_id(&self) -> Uuid {
        self.volunteer_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "pending_approval" }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "status": "approved" }))
    }
}

#[derive(Debug, Clone)]
pub struct OAuthAccountLinked {
    pub volunteer_id: VolunteerId,
    pub provider: OAuthProvider,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for OAuthAccountLinked {
    fn event_type(&self) -> &'static str {
        "oauth_account_linked"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for OAuthAccountLinked {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.volunteer_id)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Volunteer
    }
    fn entity_id(&self) -> Uuid {
        self.volunteer_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "linked_provider": self.provider.as_str() }))
    }
}

#[derive(Debug, Clone)]
pub struct RoleChanged {
    pub volunteer_id: VolunteerId,
    pub previous_role: Role,
    pub new_role: Role,
    pub changed_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for RoleChanged {
    fn event_type(&self) -> &'static str {
        "role_changed"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for RoleChanged {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.changed_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::RoleChanged
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Volunteer
    }
    fn entity_id(&self) -> Uuid {
        self.volunteer_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "role": self.previous_role.as_str() }))
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "role": self.new_role.as_str() }))
    }
}

/// compliance-audit.md: emitted by `Volunteer::anonymize`, distinct from
/// every other `Volunteer` mutation event above, so an auditor scanning
/// `audit_log` for "was this volunteer's data ever erased" can filter on
/// this specific action/entity pair without wading through ordinary
/// profile-update noise. Carries `request_id` so the row can be
/// cross-referenced against the `DataSubjectRequest` that triggered it,
/// but deliberately carries no other content -- the `before`/`after`
/// snapshots below are intentionally not the tombstoned field values,
/// since writing the anonymized name/email into `audit_log.after` would
/// itself retain the *fact but not the shape* of what was erased, and
/// writing the pre-anonymization values into `before` would defeat the
/// erasure by keeping them recoverable from the audit trail.
#[derive(Debug, Clone)]
pub struct VolunteerAnonymized {
    pub volunteer_id: VolunteerId,
    pub request_id: DataSubjectRequestId,
    pub anonymized_by: VolunteerId,
    pub occurred_at: DateTime<Utc>,
}

impl DomainEvent for VolunteerAnonymized {
    fn event_type(&self) -> &'static str {
        "volunteer_anonymized"
    }
    fn occurred_at(&self) -> DateTime<Utc> {
        self.occurred_at
    }
    fn as_auditable(&self) -> Option<&dyn AuditableEvent> {
        Some(self)
    }
}

impl AuditableEvent for VolunteerAnonymized {
    fn actor(&self) -> ActorId {
        ActorId::Volunteer(self.anonymized_by)
    }
    fn action(&self) -> AuditAction {
        AuditAction::Updated
    }
    fn entity_type(&self) -> AuditEntityType {
        AuditEntityType::Volunteer
    }
    fn entity_id(&self) -> Uuid {
        self.volunteer_id.as_uuid()
    }
    fn before(&self) -> Option<serde_json::Value> {
        None
    }
    fn after(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "anonymized": true, "request_id": self.request_id }))
    }
}
