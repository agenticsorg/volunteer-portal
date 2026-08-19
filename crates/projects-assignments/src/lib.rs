//! Projects & Assignments bounded context. See
//! `.plans/ddd/projects-assignments.md`. Depends on `kernel` and
//! `identity-access` only, per context-map.md's dependency graph.

mod events;
mod project;
mod repository;

pub use events::{ProjectClosed, ProjectCreated, ProjectLeadAdded, ProjectLeadRemoved};
pub use project::{
    EventSchedule, LeadRole, Project, ProjectError, ProjectLead, ProjectStatus, ProjectType,
};
pub use repository::{
    EventOccurrence, LeadMembershipQuery, ProjectRepository, ProjectSummary, SqlxProjectRepository,
    UpcomingEventOccurrencesQuery,
};
