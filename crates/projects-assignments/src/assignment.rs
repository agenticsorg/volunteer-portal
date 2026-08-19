use chrono::{DateTime, Utc};
use kernel::{AssignmentId, DomainEvent, ProjectId, VolunteerId};

use crate::events::{AssignmentApplied, AssignmentApproved, AssignmentRemoved};
use crate::project::{Project, ProjectStatus, ProjectType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticipationMode {
    Contributor,
    Attendee,
}

impl ParticipationMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ParticipationMode::Contributor => "contributor",
            ParticipationMode::Attendee => "attendee",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "contributor" => Some(ParticipationMode::Contributor),
            "attendee" => Some(ParticipationMode::Attendee),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssignmentStatus {
    Applied,
    Approved,
    Removed,
}

impl AssignmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssignmentStatus::Applied => "applied",
            AssignmentStatus::Approved => "approved",
            AssignmentStatus::Removed => "removed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "applied" => Some(AssignmentStatus::Applied),
            "approved" => Some(AssignmentStatus::Approved),
            "removed" => Some(AssignmentStatus::Removed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AssignmentError {
    #[error("project is not open")]
    ProjectNotOpen,
    #[error("assignment is not in the applied state")]
    NotApplied,
    #[error("actor is not a current lead of this assignment's project")]
    NotALead,
}

/// A separate aggregate from `Project` (different lifecycle, higher
/// write volume, no need to save both atomically together). This is the
/// concrete mechanism behind the amended ADR-0006 event-hours rule --
/// `participation_mode` is set once, here, at construction, and has no
/// public setter afterward.
pub struct Assignment {
    id: AssignmentId,
    volunteer_id: VolunteerId,
    project_id: ProjectId,
    role: String,
    participation_mode: ParticipationMode,
    status: AssignmentStatus,
    applied_at: DateTime<Utc>,
    decided_by: Option<VolunteerId>,
    decided_at: Option<DateTime<Utc>>,
    attended_at: Option<DateTime<Utc>>,
    pending_events: Vec<Box<dyn DomainEvent>>,
}

impl std::fmt::Debug for Assignment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Assignment")
            .field("id", &self.id)
            .field("volunteer_id", &self.volunteer_id)
            .field("project_id", &self.project_id)
            .field("role", &self.role)
            .field("participation_mode", &self.participation_mode)
            .field("status", &self.status)
            .field("applied_at", &self.applied_at)
            .field("decided_by", &self.decided_by)
            .field("decided_at", &self.decided_at)
            .field("attended_at", &self.attended_at)
            .field("pending_events_count", &self.pending_events.len())
            .finish()
    }
}

impl Assignment {
    /// The only constructor. Takes a `Project` reference (not just an
    /// id) so `participation_mode` can never be set inconsistently with
    /// the project it belongs to -- this is the single point where the
    /// amended-ADR-0006 event-hours rule is enforced; every downstream
    /// consumer (verification letters, hours reports, Notifications,
    /// Discord role sync) relies on this having been computed correctly
    /// here and never re-derives it.
    pub fn apply(
        project: &Project,
        volunteer_id: VolunteerId,
        role: String,
    ) -> Result<Assignment, AssignmentError> {
        if project.status() != ProjectStatus::Open {
            return Err(AssignmentError::ProjectNotOpen);
        }

        let participation_mode = match project.project_type() {
            ProjectType::Project => ParticipationMode::Contributor,
            ProjectType::Event => {
                if project.is_lead(volunteer_id) {
                    ParticipationMode::Contributor
                } else {
                    ParticipationMode::Attendee
                }
            }
        };

        let id = AssignmentId::new();
        let now = Utc::now();

        let event = AssignmentApplied {
            assignment_id: id,
            volunteer_id,
            project_id: project.id(),
            participation_mode,
            occurred_at: now,
        };

        Ok(Assignment {
            id,
            volunteer_id,
            project_id: project.id(),
            role,
            participation_mode,
            status: AssignmentStatus::Applied,
            applied_at: now,
            decided_by: None,
            decided_at: None,
            attended_at: None,
            pending_events: vec![Box::new(event)],
        })
    }

    /// Rehydrates an `Assignment` from persisted state. Never emits
    /// pending events.
    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: AssignmentId,
        volunteer_id: VolunteerId,
        project_id: ProjectId,
        role: String,
        participation_mode: ParticipationMode,
        status: AssignmentStatus,
        applied_at: DateTime<Utc>,
        decided_by: Option<VolunteerId>,
        decided_at: Option<DateTime<Utc>>,
        attended_at: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            id,
            volunteer_id,
            project_id,
            role,
            participation_mode,
            status,
            applied_at,
            decided_by,
            decided_at,
            attended_at,
            pending_events: Vec::new(),
        }
    }

    pub fn id(&self) -> AssignmentId {
        self.id
    }
    pub fn volunteer_id(&self) -> VolunteerId {
        self.volunteer_id
    }
    pub fn project_id(&self) -> ProjectId {
        self.project_id
    }
    pub fn role(&self) -> &str {
        &self.role
    }
    pub fn participation_mode(&self) -> ParticipationMode {
        self.participation_mode
    }
    pub fn status(&self) -> AssignmentStatus {
        self.status
    }
    pub fn applied_at(&self) -> DateTime<Utc> {
        self.applied_at
    }
    pub fn decided_by(&self) -> Option<VolunteerId> {
        self.decided_by
    }
    pub fn decided_at(&self) -> Option<DateTime<Utc>> {
        self.decided_at
    }
    pub fn attended_at(&self) -> Option<DateTime<Utc>> {
        self.attended_at
    }

    /// Only `Applied` assignments can transition to `Approved`.
    /// `decided_by` must already be a current lead of `project_id` --
    /// verified by the caller (the `apps/api` `LeadOf` extractor for a
    /// single-project request, or a `LeadMembershipQuery` re-check per
    /// entry for bulk actions spanning multiple projects) via
    /// `is_lead_verified`, since this aggregate has no way to query
    /// `project_lead` itself.
    pub fn approve(
        &mut self,
        decided_by: VolunteerId,
        is_lead_verified: bool,
    ) -> Result<(), AssignmentError> {
        if self.status != AssignmentStatus::Applied {
            return Err(AssignmentError::NotApplied);
        }
        if !is_lead_verified {
            return Err(AssignmentError::NotALead);
        }
        self.status = AssignmentStatus::Approved;
        self.decided_by = Some(decided_by);
        self.decided_at = Some(Utc::now());
        self.pending_events.push(Box::new(AssignmentApproved {
            assignment_id: self.id,
            decided_by,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// Reassignment (concept.md section 4's "remove and reassign") is
    /// modeled as `Removed` on the old `Assignment` plus a new one via
    /// `Assignment::apply` -- never a mutation of role/project on the
    /// existing row, so the audit trail shows two discrete events.
    pub fn remove(
        &mut self,
        decided_by: VolunteerId,
        is_lead_verified: bool,
        reason: Option<String>,
    ) -> Result<(), AssignmentError> {
        if !is_lead_verified {
            return Err(AssignmentError::NotALead);
        }
        self.status = AssignmentStatus::Removed;
        self.decided_by = Some(decided_by);
        self.decided_at = Some(Utc::now());
        self.pending_events.push(Box::new(AssignmentRemoved {
            assignment_id: self.id,
            decided_by,
            reason,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// Attendee-mode signup/attendance tracking (ADR-0006): no approval
    /// workflow, attendance is either recorded or not.
    pub fn mark_attended(&mut self) {
        self.attended_at = Some(Utc::now());
    }

    pub fn take_events(&mut self) -> Vec<Box<dyn DomainEvent>> {
        std::mem::take(&mut self.pending_events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{EventSchedule, LeadRole};
    use kernel::VolunteerId;

    fn open_project(project_type: ProjectType, schedule: Option<EventSchedule>) -> Project {
        Project::create(
            "Test".into(),
            "".into(),
            project_type,
            vec![],
            VolunteerId::new(),
            schedule,
        )
        .unwrap()
    }

    // participation_mode table, per projects-assignments.md.
    #[test]
    fn project_type_assignment_is_always_contributor() {
        let project = open_project(ProjectType::Project, None);
        let assignment = Assignment::apply(&project, VolunteerId::new(), "Contributor".into()).unwrap();
        assert_eq!(assignment.participation_mode(), ParticipationMode::Contributor);
    }

    #[test]
    fn event_type_lead_assignment_is_contributor() {
        let host = VolunteerId::new();
        let project = Project::create(
            "Weekly Meetup".into(),
            "".into(),
            ProjectType::Event,
            vec![],
            host,
            Some(EventSchedule {
                next_occurrence_at: Utc::now(),
                recurrence_note: None,
            }),
        )
        .unwrap();
        // `host` is already the initial lead from Project::create.
        let assignment = Assignment::apply(&project, host, "Host".into()).unwrap();
        assert_eq!(assignment.participation_mode(), ParticipationMode::Contributor);
    }

    #[test]
    fn event_type_non_lead_assignment_is_attendee() {
        let project = open_project(
            ProjectType::Event,
            Some(EventSchedule {
                next_occurrence_at: Utc::now(),
                recurrence_note: None,
            }),
        );
        let attendee = VolunteerId::new();
        let assignment = Assignment::apply(&project, attendee, "Attendee".into()).unwrap();
        assert_eq!(assignment.participation_mode(), ParticipationMode::Attendee);
    }

    // Promotion to lead after an existing assignment does not
    // retroactively change participation_mode.
    #[test]
    fn promotion_to_lead_does_not_retroactively_change_existing_assignment() {
        let mut project = open_project(
            ProjectType::Event,
            Some(EventSchedule {
                next_occurrence_at: Utc::now(),
                recurrence_note: None,
            }),
        );
        let volunteer = VolunteerId::new();
        let assignment = Assignment::apply(&project, volunteer, "Attendee".into()).unwrap();
        assert_eq!(assignment.participation_mode(), ParticipationMode::Attendee);

        // Now promote them to lead of the project.
        project.add_lead(volunteer, LeadRole::CoLead).unwrap();

        // The existing assignment is untouched -- still Attendee.
        assert_eq!(assignment.participation_mode(), ParticipationMode::Attendee);

        // A *new* assignment created after promotion is Contributor.
        let new_assignment = Assignment::apply(&project, volunteer, "Host".into()).unwrap();
        assert_eq!(new_assignment.participation_mode(), ParticipationMode::Contributor);
    }

    #[test]
    fn cannot_apply_to_a_closed_project() {
        let mut project = open_project(ProjectType::Project, None);
        project.close(VolunteerId::new());
        let err = Assignment::apply(&project, VolunteerId::new(), "Contributor".into()).unwrap_err();
        assert_eq!(err, AssignmentError::ProjectNotOpen);
    }

    // Lead-scoped authorization: approve/remove refuse without
    // is_lead_verified.
    #[test]
    fn approve_refused_without_verified_lead_membership() {
        let project = open_project(ProjectType::Project, None);
        let mut assignment = Assignment::apply(&project, VolunteerId::new(), "Contributor".into()).unwrap();
        let err = assignment.approve(VolunteerId::new(), false).unwrap_err();
        assert_eq!(err, AssignmentError::NotALead);
        assert_eq!(assignment.status(), AssignmentStatus::Applied);
    }

    #[test]
    fn approve_succeeds_with_verified_lead_membership() {
        let project = open_project(ProjectType::Project, None);
        let mut assignment = Assignment::apply(&project, VolunteerId::new(), "Contributor".into()).unwrap();
        let lead = VolunteerId::new();
        assignment.approve(lead, true).unwrap();
        assert_eq!(assignment.status(), AssignmentStatus::Approved);
        assert_eq!(assignment.decided_by(), Some(lead));
    }

    #[test]
    fn only_applied_assignments_can_be_approved() {
        let project = open_project(ProjectType::Project, None);
        let mut assignment = Assignment::apply(&project, VolunteerId::new(), "Contributor".into()).unwrap();
        assignment.approve(VolunteerId::new(), true).unwrap();
        let err = assignment.approve(VolunteerId::new(), true).unwrap_err();
        assert_eq!(err, AssignmentError::NotApplied);
    }
}
