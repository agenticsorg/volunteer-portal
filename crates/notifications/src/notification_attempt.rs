use chrono::{DateTime, Utc};
use kernel::{NotificationAttemptId, ProjectId, VolunteerId};
use uuid::Uuid;

/// notifications.md's flat delivery-log record -- no aggregate root, no
/// lifecycle beyond "attempted, then sent or failed" (see that file's
/// "No aggregate root" section).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerType {
    SignupConfirmation,
    AssignmentApproved,
    HoursApproved,
    MeetingReminder,
    VerificationLetterReady,
}

impl TriggerType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TriggerType::SignupConfirmation => "signup_confirmation",
            TriggerType::AssignmentApproved => "assignment_approved",
            TriggerType::HoursApproved => "hours_approved",
            TriggerType::MeetingReminder => "meeting_reminder",
            TriggerType::VerificationLetterReady => "verification_letter_ready",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "signup_confirmation" => Some(TriggerType::SignupConfirmation),
            "assignment_approved" => Some(TriggerType::AssignmentApproved),
            "hours_approved" => Some(TriggerType::HoursApproved),
            "meeting_reminder" => Some(TriggerType::MeetingReminder),
            "verification_letter_ready" => Some(TriggerType::VerificationLetterReady),
            _ => None,
        }
    }
}

/// `DiscordDm` exists at the type level now (concept.md section 6 lists
/// Discord DMs for the same underlying events) but every trigger sends
/// `Email` in v1 -- notifications.md is explicit that `channel` is
/// `Email` for all five triggers as currently scoped; nothing in this
/// crate's dispatch logic constructs a `DiscordDm`-channel attempt yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Email,
    DiscordDm,
}

impl Channel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Channel::Email => "email",
            Channel::DiscordDm => "discord_dm",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "email" => Some(Channel::Email),
            "discord_dm" => Some(Channel::DiscordDm),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptStatus {
    Pending,
    Sent,
    Failed,
}

impl AttemptStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttemptStatus::Pending => "pending",
            AttemptStatus::Sent => "sent",
            AttemptStatus::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(AttemptStatus::Pending),
            "sent" => Some(AttemptStatus::Sent),
            "failed" => Some(AttemptStatus::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NotificationAttempt {
    id: NotificationAttemptId,
    trigger_type: TriggerType,
    recipient: VolunteerId,
    channel: Channel,
    /// The outbox event id that caused this attempt -- `None` for the
    /// meeting-reminder trigger, which isn't outbox-sourced.
    source_event_id: Option<Uuid>,
    /// `(project_id, next_occurrence_at)` -- the meeting-reminder
    /// trigger's own idempotency key, `None` for every other trigger.
    project_id: Option<ProjectId>,
    next_occurrence_at: Option<DateTime<Utc>>,
    status: AttemptStatus,
    attempted_at: DateTime<Utc>,
    error: Option<String>,
}

impl NotificationAttempt {
    /// A successful delivery. `NotificationSent` is left to the caller
    /// to construct and log/trace -- see notifications.md's "Domain
    /// events" section on why it isn't wired through
    /// `record_audit_events`/`record_outbox_events` (implements neither
    /// `AuditableEvent` nor `OutboxEvent`).
    pub fn sent(
        trigger_type: TriggerType,
        recipient: VolunteerId,
        channel: Channel,
        source_event_id: Option<Uuid>,
        project_id: Option<ProjectId>,
        next_occurrence_at: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            id: NotificationAttemptId::new(),
            trigger_type,
            recipient,
            channel,
            source_event_id,
            project_id,
            next_occurrence_at,
            status: AttemptStatus::Sent,
            attempted_at: Utc::now(),
            error: None,
        }
    }

    /// A failed delivery -- per build-roadmap.md's Phase 7 exit
    /// criterion, this is a data record, not a synchronous retry loop:
    /// the poller's *next tick* is what retries, by re-polling the still-
    /// unprocessed outbox row (or, for the meeting-reminder trigger, by
    /// the reminder job's next scheduled run finding no matching
    /// `notification_attempt` row yet).
    #[allow(clippy::too_many_arguments)]
    pub fn failed(
        trigger_type: TriggerType,
        recipient: VolunteerId,
        channel: Channel,
        source_event_id: Option<Uuid>,
        project_id: Option<ProjectId>,
        next_occurrence_at: Option<DateTime<Utc>>,
        error: String,
    ) -> Self {
        Self {
            id: NotificationAttemptId::new(),
            trigger_type,
            recipient,
            channel,
            source_event_id,
            project_id,
            next_occurrence_at,
            status: AttemptStatus::Failed,
            attempted_at: Utc::now(),
            error: Some(error),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: NotificationAttemptId,
        trigger_type: TriggerType,
        recipient: VolunteerId,
        channel: Channel,
        source_event_id: Option<Uuid>,
        project_id: Option<ProjectId>,
        next_occurrence_at: Option<DateTime<Utc>>,
        status: AttemptStatus,
        attempted_at: DateTime<Utc>,
        error: Option<String>,
    ) -> Self {
        Self {
            id,
            trigger_type,
            recipient,
            channel,
            source_event_id,
            project_id,
            next_occurrence_at,
            status,
            attempted_at,
            error,
        }
    }

    pub fn id(&self) -> NotificationAttemptId {
        self.id
    }
    pub fn trigger_type(&self) -> TriggerType {
        self.trigger_type
    }
    pub fn recipient(&self) -> VolunteerId {
        self.recipient
    }
    pub fn channel(&self) -> Channel {
        self.channel
    }
    pub fn source_event_id(&self) -> Option<Uuid> {
        self.source_event_id
    }
    pub fn project_id(&self) -> Option<ProjectId> {
        self.project_id
    }
    pub fn next_occurrence_at(&self) -> Option<DateTime<Utc>> {
        self.next_occurrence_at
    }
    pub fn status(&self) -> AttemptStatus {
        self.status
    }
    pub fn attempted_at(&self) -> DateTime<Utc> {
        self.attempted_at
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_type_round_trips_through_its_string_form() {
        for t in [
            TriggerType::SignupConfirmation,
            TriggerType::AssignmentApproved,
            TriggerType::HoursApproved,
            TriggerType::MeetingReminder,
            TriggerType::VerificationLetterReady,
        ] {
            assert_eq!(TriggerType::parse(t.as_str()), Some(t));
        }
    }

    #[test]
    fn channel_and_status_round_trip_through_their_string_forms() {
        assert_eq!(Channel::parse(Channel::Email.as_str()), Some(Channel::Email));
        assert_eq!(Channel::parse(Channel::DiscordDm.as_str()), Some(Channel::DiscordDm));
        assert_eq!(AttemptStatus::parse(AttemptStatus::Pending.as_str()), Some(AttemptStatus::Pending));
        assert_eq!(AttemptStatus::parse(AttemptStatus::Sent.as_str()), Some(AttemptStatus::Sent));
        assert_eq!(AttemptStatus::parse(AttemptStatus::Failed.as_str()), Some(AttemptStatus::Failed));
    }

    #[test]
    fn sent_constructor_produces_a_sent_attempt_with_no_error() {
        let recipient = VolunteerId::new();
        let attempt = NotificationAttempt::sent(TriggerType::HoursApproved, recipient, Channel::Email, Some(Uuid::new_v4()), None, None);
        assert_eq!(attempt.status(), AttemptStatus::Sent);
        assert_eq!(attempt.recipient(), recipient);
        assert!(attempt.error().is_none());
    }

    #[test]
    fn failed_constructor_produces_a_failed_attempt_carrying_the_error() {
        let recipient = VolunteerId::new();
        let attempt = NotificationAttempt::failed(
            TriggerType::HoursApproved,
            recipient,
            Channel::Email,
            Some(Uuid::new_v4()),
            None,
            None,
            "provider unreachable".to_string(),
        );
        assert_eq!(attempt.status(), AttemptStatus::Failed);
        assert_eq!(attempt.error(), Some("provider unreachable"));
    }
}
