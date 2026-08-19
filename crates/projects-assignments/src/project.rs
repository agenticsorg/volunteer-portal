use chrono::{DateTime, Utc};
use kernel::{DomainEvent, ProjectId, Skill, VolunteerId};

use crate::events::{ProjectClosed, ProjectCreated, ProjectLeadAdded, ProjectLeadRemoved};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectType {
    Project,
    Event,
}

impl ProjectType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectType::Project => "project",
            ProjectType::Event => "event",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "project" => Some(ProjectType::Project),
            "event" => Some(ProjectType::Event),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectStatus {
    Open,
    Closed,
}

impl ProjectStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectStatus::Open => "open",
            ProjectStatus::Closed => "closed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(ProjectStatus::Open),
            "closed" => Some(ProjectStatus::Closed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeadRole {
    Lead,
    CoLead,
}

impl LeadRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            LeadRole::Lead => "lead",
            LeadRole::CoLead => "co-lead",
        }
    }

    pub fn parse(value: &str) -> Self {
        // ADR-0005's project_lead.role "reserved for future
        // differentiation" -- any value other than the literal "co-lead"
        // is read as the default Lead, not an error, since the column
        // has no CHECK constraint (deliberately: it's a label, not an
        // enforced enum, per ADR-0005).
        match value {
            "co-lead" => LeadRole::CoLead,
            _ => LeadRole::Lead,
        }
    }
}

/// Not in concept.md's original four-object model; added per
/// projects-assignments.md so Notifications' "meeting reminder" trigger
/// (Phase 7) has something to compute "when is the next occurrence" from.
/// Deliberately minimal: a single next-occurrence timestamp plus an
/// optional human-readable note, not a full RRULE engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventSchedule {
    pub next_occurrence_at: DateTime<Utc>,
    pub recurrence_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLead {
    pub volunteer_id: VolunteerId,
    pub role: LeadRole,
    pub assigned_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProjectError {
    #[error("project name is required")]
    NameRequired,
    #[error("project name must be at most 200 characters")]
    NameTooLong,
    #[error("cannot remove the last lead of a project")]
    CannotRemoveLastLead,
    #[error("event-type projects require a schedule")]
    ScheduleRequiredForEvent,
    #[error("project-type projects must not carry a schedule")]
    ScheduleNotAllowedForProject,
    #[error("volunteer is not a lead of this project")]
    NotALead,
    #[error("volunteer is already a lead of this project")]
    AlreadyALead,
}

/// The Projects & Assignments aggregate root for both "project" and
/// "event" (via the `project_type` discriminator, amended ADR-0006) --
/// see projects-assignments.md's "Design note" for why this is one
/// aggregate, not `Project` + `Event`. `ProjectLead` is an entity within
/// this aggregate (not its own), since lead-list consistency must be
/// strong (no reading a stale lead list while approving hours).
pub struct Project {
    id: ProjectId,
    name: String,
    description: String,
    project_type: ProjectType,
    needed_skills: Vec<Skill>,
    status: ProjectStatus,
    leads: Vec<ProjectLead>,
    schedule: Option<EventSchedule>,
    created_at: DateTime<Utc>,
    pending_events: Vec<Box<dyn DomainEvent>>,
}

impl std::fmt::Debug for Project {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Project")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("description", &self.description)
            .field("project_type", &self.project_type)
            .field("needed_skills", &self.needed_skills)
            .field("status", &self.status)
            .field("leads", &self.leads)
            .field("schedule", &self.schedule)
            .field("created_at", &self.created_at)
            .field("pending_events_count", &self.pending_events.len())
            .finish()
    }
}

fn validate_name(name: &str) -> Result<(), ProjectError> {
    if name.trim().is_empty() {
        return Err(ProjectError::NameRequired);
    }
    if name.chars().count() > 200 {
        return Err(ProjectError::NameTooLong);
    }
    Ok(())
}

impl Project {
    /// The only constructor. Always creates exactly one initial lead --
    /// invariant 1 (at least one lead at all times) holds from the first
    /// instant the aggregate exists.
    pub fn create(
        name: String,
        description: String,
        project_type: ProjectType,
        needed_skills: Vec<Skill>,
        initial_lead: VolunteerId,
        schedule: Option<EventSchedule>,
    ) -> Result<Self, ProjectError> {
        validate_name(&name)?;

        // Invariant 5: schedule present iff event-type.
        match (project_type, &schedule) {
            (ProjectType::Event, None) => return Err(ProjectError::ScheduleRequiredForEvent),
            (ProjectType::Project, Some(_)) => {
                return Err(ProjectError::ScheduleNotAllowedForProject)
            }
            _ => {}
        }

        let id = ProjectId::new();
        let now = Utc::now();

        let event = ProjectCreated {
            project_id: id,
            name: name.clone(),
            project_type,
            initial_lead,
            occurred_at: now,
        };

        Ok(Self {
            id,
            name,
            description,
            project_type,
            needed_skills,
            status: ProjectStatus::Open,
            leads: vec![ProjectLead {
                volunteer_id: initial_lead,
                role: LeadRole::Lead,
                assigned_at: now,
            }],
            schedule,
            created_at: now,
            pending_events: vec![Box::new(event)],
        })
    }

    /// Rehydrates a `Project` from persisted state. Never emits pending
    /// events -- loading is not a domain action.
    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: ProjectId,
        name: String,
        description: String,
        project_type: ProjectType,
        needed_skills: Vec<Skill>,
        status: ProjectStatus,
        leads: Vec<ProjectLead>,
        schedule: Option<EventSchedule>,
        created_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            name,
            description,
            project_type,
            needed_skills,
            status,
            leads,
            schedule,
            created_at,
            pending_events: Vec::new(),
        }
    }

    pub fn id(&self) -> ProjectId {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn description(&self) -> &str {
        &self.description
    }
    pub fn project_type(&self) -> ProjectType {
        self.project_type
    }
    pub fn needed_skills(&self) -> &[Skill] {
        &self.needed_skills
    }
    pub fn status(&self) -> ProjectStatus {
        self.status
    }
    pub fn leads(&self) -> &[ProjectLead] {
        &self.leads
    }
    pub fn schedule(&self) -> Option<&EventSchedule> {
        self.schedule.as_ref()
    }
    pub fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }

    pub fn is_lead(&self, volunteer_id: VolunteerId) -> bool {
        self.leads.iter().any(|l| l.volunteer_id == volunteer_id)
    }

    /// Invariant 3 (the half of it that lives on `Project` itself --
    /// `Assignment::apply`, Prompt 3.2, is the other half, checking this
    /// same fact from the `Assignment` side).
    pub fn is_open(&self) -> bool {
        self.status == ProjectStatus::Open
    }

    pub fn add_lead(
        &mut self,
        volunteer_id: VolunteerId,
        role: LeadRole,
    ) -> Result<(), ProjectError> {
        if self.is_lead(volunteer_id) {
            return Err(ProjectError::AlreadyALead);
        }
        self.leads.push(ProjectLead {
            volunteer_id,
            role,
            assigned_at: Utc::now(),
        });
        self.pending_events.push(Box::new(ProjectLeadAdded {
            project_id: self.id,
            volunteer_id,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// Invariant 1: the last lead cannot be removed.
    pub fn remove_lead(&mut self, volunteer_id: VolunteerId) -> Result<(), ProjectError> {
        if !self.is_lead(volunteer_id) {
            return Err(ProjectError::NotALead);
        }
        if self.leads.len() == 1 {
            return Err(ProjectError::CannotRemoveLastLead);
        }
        self.leads.retain(|l| l.volunteer_id != volunteer_id);
        self.pending_events.push(Box::new(ProjectLeadRemoved {
            project_id: self.id,
            volunteer_id,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    pub fn close(&mut self, closed_by: VolunteerId) {
        if self.status == ProjectStatus::Closed {
            return;
        }
        self.status = ProjectStatus::Closed;
        self.pending_events.push(Box::new(ProjectClosed {
            project_id: self.id,
            closed_by,
            occurred_at: Utc::now(),
        }));
    }

    pub fn take_events(&mut self) -> Vec<Box<dyn DomainEvent>> {
        std::mem::take(&mut self.pending_events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lead() -> VolunteerId {
        VolunteerId::new()
    }

    // Invariant 1: at least one lead at all times.
    #[test]
    fn cannot_remove_the_last_lead() {
        let initial = lead();
        let mut project =
            Project::create("Website".into(), "".into(), ProjectType::Project, vec![], initial, None)
                .unwrap();
        let err = project.remove_lead(initial).unwrap_err();
        assert_eq!(err, ProjectError::CannotRemoveLastLead);
        assert_eq!(project.leads().len(), 1);
    }

    #[test]
    fn co_lead_can_be_removed_when_another_lead_remains() {
        let initial = lead();
        let co = lead();
        let mut project =
            Project::create("Website".into(), "".into(), ProjectType::Project, vec![], initial, None)
                .unwrap();
        project.add_lead(co, LeadRole::CoLead).unwrap();
        project.remove_lead(co).unwrap();
        assert_eq!(project.leads().len(), 1);
        assert!(project.is_lead(initial));
    }

    // Invariant 2: project_type is immutable -- there is simply no
    // setter for it; this test documents that intent rather than
    // exercising a rejection path.
    #[test]
    fn project_type_has_no_setter() {
        let project = Project::create(
            "Website".into(),
            "".into(),
            ProjectType::Project,
            vec![],
            lead(),
            None,
        )
        .unwrap();
        assert_eq!(project.project_type(), ProjectType::Project);
    }

    // Invariant 4: name validation.
    #[test]
    fn empty_name_is_rejected() {
        let err = Project::create("   ".into(), "".into(), ProjectType::Project, vec![], lead(), None)
            .unwrap_err();
        assert_eq!(err, ProjectError::NameRequired);
    }

    #[test]
    fn empty_needed_skills_is_allowed() {
        let project =
            Project::create("Website".into(), "".into(), ProjectType::Project, vec![], lead(), None)
                .unwrap();
        assert!(project.needed_skills().is_empty());
    }

    // Invariant 5: schedule present iff event-type.
    #[test]
    fn event_without_schedule_is_rejected() {
        let err = Project::create("Meetup".into(), "".into(), ProjectType::Event, vec![], lead(), None)
            .unwrap_err();
        assert_eq!(err, ProjectError::ScheduleRequiredForEvent);
    }

    #[test]
    fn project_with_schedule_is_rejected() {
        let schedule = EventSchedule {
            next_occurrence_at: Utc::now(),
            recurrence_note: None,
        };
        let err = Project::create(
            "Website".into(),
            "".into(),
            ProjectType::Project,
            vec![],
            lead(),
            Some(schedule),
        )
        .unwrap_err();
        assert_eq!(err, ProjectError::ScheduleNotAllowedForProject);
    }

    #[test]
    fn event_with_schedule_succeeds() {
        let schedule = EventSchedule {
            next_occurrence_at: Utc::now(),
            recurrence_note: Some("every Wednesday".into()),
        };
        let project = Project::create(
            "Weekly Meetup".into(),
            "".into(),
            ProjectType::Event,
            vec![],
            lead(),
            Some(schedule),
        )
        .unwrap();
        assert!(project.schedule().is_some());
    }

    #[test]
    fn create_emits_project_created_event() {
        let mut project =
            Project::create("Website".into(), "".into(), ProjectType::Project, vec![], lead(), None)
                .unwrap();
        let events = project.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type(), "project_created");
    }
}
