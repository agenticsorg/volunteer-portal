use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::id::VolunteerId;

/// Every mutating command handler that changes state produces one or more
/// of these. See `.plans/ddd/context-map.md`'s "Cross-context
/// communication" section for the two mechanisms events feed: the
/// same-transaction `audit_log` write (for `AuditableEvent`s) and the
/// transactional outbox (for anything Notifications/Discord Integration
/// react to).
pub trait DomainEvent: Send + Sync + 'static {
    fn event_type(&self) -> &'static str;
    fn occurred_at(&self) -> DateTime<Utc>;
}

/// A `DomainEvent` that is also a compliance record. Per ADR-0005 and
/// context-map.md, the `apps/api` scoped-transaction helper inspects every
/// event a repository's `save()` returns for this trait and writes an
/// `audit_log` row in the same transaction, unconditionally — no context
/// ever calls an "insert into audit_log" function by hand.
pub trait AuditableEvent: DomainEvent {
    fn actor(&self) -> ActorId;
    fn action(&self) -> AuditAction;
    fn entity_type(&self) -> AuditEntityType;
    fn entity_id(&self) -> Uuid;
    fn before(&self) -> Option<serde_json::Value>;
    fn after(&self) -> Option<serde_json::Value>;
}

/// Who performed the action an `AuditableEvent` records. `System` covers
/// scheduled jobs (e.g. the Discord role reconcile job) with no human
/// actor — `audit_log.actor_id` is nullable specifically for this case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorId {
    Volunteer(VolunteerId),
    System,
}

/// Mirrors ADR-0005's `audit_log.action` column exactly. Stored as text
/// (enum-checked at the application layer, not a Postgres native enum), so
/// `Custom` can carry a new action value without a migration — matching
/// ADR-0005's "text (enum-checked)" column type and compliance-audit.md's
/// `AuditAction` definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditAction {
    Created,
    Updated,
    Deleted,
    HourApproved,
    HourRejected,
    HourAdjusted,
    RoleChanged,
    Custom(&'static str),
}

impl AuditAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuditAction::Created => "created",
            AuditAction::Updated => "updated",
            AuditAction::Deleted => "deleted",
            AuditAction::HourApproved => "hour_approved",
            AuditAction::HourRejected => "hour_rejected",
            AuditAction::HourAdjusted => "hour_adjusted",
            AuditAction::RoleChanged => "role_changed",
            AuditAction::Custom(s) => s,
        }
    }
}

/// Mirrors ADR-0005's `audit_log.entity_type` column, extended per
/// compliance-audit.md with `DataSubjectRequest` (Prompt 10.2). Classifies
/// by the affected aggregate, not by which context triggered the change —
/// e.g. a Discord-link event still has `entity_type: Volunteer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditEntityType {
    Volunteer,
    Project,
    Assignment,
    HourEntry,
    DataSubjectRequest,
}

impl AuditEntityType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuditEntityType::Volunteer => "volunteer",
            AuditEntityType::Project => "project",
            AuditEntityType::Assignment => "assignment",
            AuditEntityType::HourEntry => "hour_entry",
            AuditEntityType::DataSubjectRequest => "data_subject_request",
        }
    }
}
