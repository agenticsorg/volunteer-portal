//! Projects & Assignments bounded context. See
//! `.plans/ddd/projects-assignments.md`. Depends on `kernel` and
//! `identity-access` only, per context-map.md's dependency graph.

mod assignment;
mod events;
mod project;
mod repository;

pub use assignment::{Assignment, AssignmentError, AssignmentStatus, ParticipationMode};
pub use events::{
    AssignmentApplied, AssignmentApproved, AssignmentRemoved, ProjectClosed, ProjectCreated,
    ProjectLeadAdded, ProjectLeadRemoved,
};
pub use project::{
    EventSchedule, LeadRole, Project, ProjectError, ProjectLead, ProjectStatus, ProjectType,
};
pub use repository::{
    ActiveContributorMembershipsQuery, AssignmentRepository, EventOccurrence, LeadMembershipQuery,
    ProjectRepository, ProjectSummary, SqlxAssignmentRepository, SqlxProjectRepository,
    UpcomingEventOccurrencesQuery,
};
