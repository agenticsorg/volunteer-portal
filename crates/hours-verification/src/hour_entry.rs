use chrono::{DateTime, NaiveDate, Utc};
use kernel::{AssignmentId, DomainEvent, HourEntryId, VolunteerId};

use crate::assignment_snapshot::{AssignmentSnapshot, AssignmentStatus, ParticipationMode};
use crate::error::HourEntryError;
use crate::events::{HoursAdjusted, HoursApproved, HoursLogged, HoursRejected};
use crate::hours::Hours;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HourEntryStatus {
    Pending,
    Approved,
    Rejected,
}

impl HourEntryStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            HourEntryStatus::Pending => "pending",
            HourEntryStatus::Approved => "approved",
            HourEntryStatus::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(HourEntryStatus::Pending),
            "approved" => Some(HourEntryStatus::Approved),
            "rejected" => Some(HourEntryStatus::Rejected),
            _ => None,
        }
    }
}

/// concept.md section 8: "manual hour adjustment with a visible audit
/// trail".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adjustment {
    pub adjusted_by: VolunteerId,
    pub previous_hours: Hours,
    pub reason: String,
    pub adjusted_at: DateTime<Utc>,
}

pub struct HourEntry {
    id: HourEntryId,
    volunteer_id: VolunteerId,
    assignment_id: AssignmentId,
    date: NaiveDate,
    hours: Hours,
    description: String,
    status: HourEntryStatus,
    approver_id: Option<VolunteerId>,
    decided_at: Option<DateTime<Utc>>,
    adjustment: Option<Adjustment>,
    pending_events: Vec<Box<dyn DomainEvent>>,
}

impl std::fmt::Debug for HourEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HourEntry")
            .field("id", &self.id)
            .field("volunteer_id", &self.volunteer_id)
            .field("assignment_id", &self.assignment_id)
            .field("date", &self.date)
            .field("hours", &self.hours)
            .field("description", &self.description)
            .field("status", &self.status)
            .field("approver_id", &self.approver_id)
            .field("decided_at", &self.decided_at)
            .field("adjustment", &self.adjustment)
            .field("pending_events_count", &self.pending_events.len())
            .finish()
    }
}

impl HourEntry {
    /// The only constructor for a self-logged entry. Refuses to build
    /// against any non-`Contributor`-mode `AssignmentSnapshot` -- the
    /// other half of the event-hours invariant Prompt 3.2 started on
    /// `Assignment::apply`; both halves must agree
    /// (hours-verification.md).
    pub fn log(
        assignment: &AssignmentSnapshot,
        date: NaiveDate,
        hours: Hours,
        description: String,
    ) -> Result<HourEntry, HourEntryError> {
        if assignment.participation_mode != ParticipationMode::Contributor {
            return Err(HourEntryError::AssignmentNotEligibleForHours);
        }
        if assignment.status != AssignmentStatus::Approved {
            return Err(HourEntryError::AssignmentNotActive);
        }
        if description.trim().is_empty() {
            return Err(HourEntryError::DescriptionRequired);
        }

        let id = HourEntryId::new();
        let now = Utc::now();

        let event = HoursLogged {
            hour_entry_id: id,
            assignment_id: assignment.assignment_id,
            volunteer_id: assignment.volunteer_id,
            hours,
            date,
            occurred_at: now,
        };

        Ok(HourEntry {
            id,
            volunteer_id: assignment.volunteer_id,
            assignment_id: assignment.assignment_id,
            date,
            hours,
            description,
            status: HourEntryStatus::Pending,
            approver_id: None,
            decided_at: None,
            adjustment: None,
            pending_events: vec![Box::new(event)],
        })
    }

    /// Rehydrates an `HourEntry` from persisted state. Never emits
    /// pending events.
    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: HourEntryId,
        volunteer_id: VolunteerId,
        assignment_id: AssignmentId,
        date: NaiveDate,
        hours: Hours,
        description: String,
        status: HourEntryStatus,
        approver_id: Option<VolunteerId>,
        decided_at: Option<DateTime<Utc>>,
        adjustment: Option<Adjustment>,
    ) -> Self {
        Self {
            id,
            volunteer_id,
            assignment_id,
            date,
            hours,
            description,
            status,
            approver_id,
            decided_at,
            adjustment,
            pending_events: Vec::new(),
        }
    }

    pub fn id(&self) -> HourEntryId {
        self.id
    }
    pub fn volunteer_id(&self) -> VolunteerId {
        self.volunteer_id
    }
    pub fn assignment_id(&self) -> AssignmentId {
        self.assignment_id
    }
    pub fn date(&self) -> NaiveDate {
        self.date
    }
    pub fn hours(&self) -> Hours {
        self.hours
    }
    pub fn description(&self) -> &str {
        &self.description
    }
    pub fn status(&self) -> HourEntryStatus {
        self.status
    }
    pub fn approver_id(&self) -> Option<VolunteerId> {
        self.approver_id
    }
    pub fn decided_at(&self) -> Option<DateTime<Utc>> {
        self.decided_at
    }
    pub fn adjustment(&self) -> Option<&Adjustment> {
        self.adjustment.as_ref()
    }

    /// Only `Pending` entries can transition to `Approved`. The approver
    /// must be a lead of the entry's project or an admin -- checked by
    /// the `apps/api` `LeadOf`/`AdminUser`/`LeadOfOrAdmin` extractors
    /// first, re-checked here via `is_authorized` for bulk-approve
    /// (concept.md section 5), since a single-entry extractor doesn't
    /// cover a batch spanning multiple projects
    /// (hours-verification.md's "Other invariants").
    pub fn approve(
        &mut self,
        approver_id: VolunteerId,
        is_authorized: bool,
    ) -> Result<(), HourEntryError> {
        if self.status != HourEntryStatus::Pending {
            return Err(HourEntryError::NotPending);
        }
        if !is_authorized {
            return Err(HourEntryError::NotAuthorized);
        }
        self.status = HourEntryStatus::Approved;
        self.approver_id = Some(approver_id);
        self.decided_at = Some(Utc::now());
        self.pending_events.push(Box::new(HoursApproved {
            hour_entry_id: self.id,
            approver_id,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// Only `Pending` entries can transition to `Rejected`. Same
    /// authorization shape as `approve`.
    pub fn reject(
        &mut self,
        approver_id: VolunteerId,
        is_authorized: bool,
        reason: Option<String>,
    ) -> Result<(), HourEntryError> {
        if self.status != HourEntryStatus::Pending {
            return Err(HourEntryError::NotPending);
        }
        if !is_authorized {
            return Err(HourEntryError::NotAuthorized);
        }
        self.status = HourEntryStatus::Rejected;
        self.approver_id = Some(approver_id);
        self.decided_at = Some(Utc::now());
        self.pending_events.push(Box::new(HoursRejected {
            hour_entry_id: self.id,
            approver_id,
            reason,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// `Adjustment` can only be applied to an `Approved` entry, only by
    /// an admin (not a lead -- concept.md section 8 places manual
    /// adjustment under Admin, not project leads; `is_admin` is checked
    /// by the caller via `AdminUser`, matching `approve`/`reject`'s
    /// pattern of the aggregate trusting a caller-supplied authorization
    /// bool rather than querying role itself), and always requires a
    /// non-empty `reason`.
    pub fn adjust(
        &mut self,
        adjusted_by: VolunteerId,
        is_admin: bool,
        new_hours: Hours,
        reason: String,
    ) -> Result<(), HourEntryError> {
        if self.status != HourEntryStatus::Approved {
            return Err(HourEntryError::NotApproved);
        }
        if !is_admin {
            return Err(HourEntryError::NotAuthorized);
        }
        if reason.trim().is_empty() {
            return Err(HourEntryError::AdjustmentReasonRequired);
        }

        let previous_hours = self.hours;
        let now = Utc::now();
        self.adjustment = Some(Adjustment {
            adjusted_by,
            previous_hours,
            reason: reason.clone(),
            adjusted_at: now,
        });
        self.hours = new_hours;
        self.pending_events.push(Box::new(HoursAdjusted {
            hour_entry_id: self.id,
            adjusted_by,
            previous_hours,
            new_hours,
            reason,
            occurred_at: now,
        }));
        Ok(())
    }

    pub fn take_events(&mut self) -> Vec<Box<dyn DomainEvent>> {
        std::mem::take(&mut self.pending_events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kernel::ProjectId;
    use rust_decimal::Decimal;

    fn contributor_snapshot(status: AssignmentStatus) -> AssignmentSnapshot {
        AssignmentSnapshot {
            assignment_id: AssignmentId::new(),
            volunteer_id: VolunteerId::new(),
            project_id: ProjectId::new(),
            participation_mode: ParticipationMode::Contributor,
            status,
        }
    }

    fn attendee_snapshot(status: AssignmentStatus) -> AssignmentSnapshot {
        AssignmentSnapshot {
            assignment_id: AssignmentId::new(),
            volunteer_id: VolunteerId::new(),
            project_id: ProjectId::new(),
            participation_mode: ParticipationMode::Attendee,
            status,
        }
    }

    fn hours(value: i64) -> Hours {
        Hours::new(Decimal::from(value)).unwrap()
    }

    // The other half of the event-hours invariant: refuses construction
    // against a non-Contributor assignment.
    #[test]
    fn refuses_construction_against_attendee_mode_assignment() {
        let snapshot = attendee_snapshot(AssignmentStatus::Approved);
        let err = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap_err();
        assert_eq!(err, HourEntryError::AssignmentNotEligibleForHours);
    }

    #[test]
    fn succeeds_against_contributor_mode_event_lead_assignment() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(3),
            "Led setup".to_string(),
        )
        .unwrap();
        assert_eq!(entry.status(), HourEntryStatus::Pending);
        assert_eq!(entry.hours(), hours(3));
    }

    #[test]
    fn refuses_construction_against_non_approved_assignment() {
        let snapshot = contributor_snapshot(AssignmentStatus::Applied);
        let err = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap_err();
        assert_eq!(err, HourEntryError::AssignmentNotActive);
    }

    #[test]
    fn refuses_empty_description() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let err = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "   ".to_string(),
        )
        .unwrap_err();
        assert_eq!(err, HourEntryError::DescriptionRequired);
    }

    #[test]
    fn hours_rejects_non_positive_and_over_24() {
        assert_eq!(
            Hours::new(Decimal::from(0)).unwrap_err(),
            HourEntryError::NonPositiveHours
        );
        assert_eq!(
            Hours::new(Decimal::from(-1)).unwrap_err(),
            HourEntryError::NonPositiveHours
        );
        assert_eq!(
            Hours::new(Decimal::from(25)).unwrap_err(),
            HourEntryError::ExceedsSingleEntryMax
        );
        assert!(Hours::new(Decimal::from(24)).is_ok());
    }

    #[test]
    fn approve_transitions_pending_to_approved() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        let approver = VolunteerId::new();
        entry.approve(approver, true).unwrap();
        assert_eq!(entry.status(), HourEntryStatus::Approved);
        assert_eq!(entry.approver_id(), Some(approver));
    }

    #[test]
    fn approve_refused_without_authorization() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        let err = entry.approve(VolunteerId::new(), false).unwrap_err();
        assert_eq!(err, HourEntryError::NotAuthorized);
        assert_eq!(entry.status(), HourEntryStatus::Pending);
    }

    #[test]
    fn only_pending_entries_can_be_approved() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        entry.approve(VolunteerId::new(), true).unwrap();
        let err = entry.approve(VolunteerId::new(), true).unwrap_err();
        assert_eq!(err, HourEntryError::NotPending);
    }

    #[test]
    fn reject_transitions_pending_to_rejected() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        entry
            .reject(VolunteerId::new(), true, Some("Duplicate entry".to_string()))
            .unwrap();
        assert_eq!(entry.status(), HourEntryStatus::Rejected);
    }

    #[test]
    fn adjust_requires_approved_status() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        let err = entry
            .adjust(VolunteerId::new(), true, hours(3), "Correction".to_string())
            .unwrap_err();
        assert_eq!(err, HourEntryError::NotApproved);
    }

    #[test]
    fn adjust_requires_admin_scope_not_lead() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        entry.approve(VolunteerId::new(), true).unwrap();
        let err = entry
            .adjust(VolunteerId::new(), false, hours(3), "Correction".to_string())
            .unwrap_err();
        assert_eq!(err, HourEntryError::NotAuthorized);
    }

    #[test]
    fn adjust_requires_non_empty_reason() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        entry.approve(VolunteerId::new(), true).unwrap();
        let err = entry
            .adjust(VolunteerId::new(), true, hours(3), "  ".to_string())
            .unwrap_err();
        assert_eq!(err, HourEntryError::AdjustmentReasonRequired);
    }

    #[test]
    fn adjust_records_before_and_after_hours() {
        let snapshot = contributor_snapshot(AssignmentStatus::Approved);
        let mut entry = HourEntry::log(
            &snapshot,
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            hours(2),
            "Setup".to_string(),
        )
        .unwrap();
        entry.approve(VolunteerId::new(), true).unwrap();
        let admin = VolunteerId::new();
        entry
            .adjust(admin, true, hours(4), "Undercounted setup time".to_string())
            .unwrap();
        assert_eq!(entry.hours(), hours(4));
        let adjustment = entry.adjustment().unwrap();
        assert_eq!(adjustment.previous_hours, hours(2));
        assert_eq!(adjustment.adjusted_by, admin);
        assert_eq!(adjustment.reason, "Undercounted setup time");
    }
}
