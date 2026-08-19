//! Shared kernel: `Id<T>` newtypes, `DomainEvent`/`AuditableEvent` traits,
//! `ActorId`, shared error types, and the RLS-safe scoped-transaction
//! helper. Every other crate in this workspace depends on `kernel`; per
//! `.plans/ddd/context-map.md`'s acyclic dependency graph, `kernel` itself
//! depends on nothing in this workspace.

mod audit;
mod db;
mod error;
mod events;
mod id;
mod skill;

pub use audit::record_audit_events;
pub use db::ScopedDb;
pub use error::RepoError;
pub use events::{ActorId, AuditAction, AuditEntityType, AuditableEvent, DomainEvent};
pub use id::{
    AssignmentId, AssignmentMarker, DataSubjectRequestId, DataSubjectRequestMarker, HourEntryId,
    HourEntryMarker, Id, ProjectId, ProjectMarker, VolunteerId, VolunteerMarker,
};
pub use skill::{Skill, SkillError};
