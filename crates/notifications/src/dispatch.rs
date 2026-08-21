//! The application-layer logic tying every port in this crate together.
//! `apps/api`'s two scheduled-job binaries
//! (`bin/process_notification_outbox.rs`, `bin/send_meeting_reminders.rs`
//! -- ADR-0012's "Fly.io Machines/cron-equivalent scheduling", the same
//! shape as Prompt 5.1's `reconcile_discord_roles.rs`) are the only
//! callers of `NotificationDispatcher` in the real binary; both are thin
//! wiring over this.

use chrono::{DateTime, Utc};
use identity_access::VolunteerSummaryQuery;
use kernel::{OutboxRow, ProjectId, RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::discord_dm::DiscordDmSender;
use crate::email_provider::{EmailError, EmailProvider, EmailTemplate, ProviderMessageId, TemplateData};
use crate::notification_attempt::{Channel, NotificationAttempt, TriggerType};
use crate::recipient::{AssignmentRecipientQuery, HourEntryRecipientQuery};
use crate::repository::NotificationAttemptRepository;

#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    #[error(transparent)]
    Repo(#[from] RepoError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    Sent,
    Failed(String),
    /// The idempotency check (`exists_for_source_event`/
    /// `exists_for_occurrence`) found a prior attempt -- a no-op, per
    /// notifications.md's "Idempotency" section, not an error.
    AlreadyHandled,
    /// The outbox row's `event_type` resolved to a `TriggerType` but the
    /// recipient couldn't be resolved (e.g. the referenced assignment/
    /// hour entry no longer exists) -- recorded as a failure so it's
    /// visible, not silently dropped.
    RecipientNotFound,
    /// An `event_type` this dispatcher doesn't recognize. Not an error:
    /// `domain_event_outbox` is generic kernel infrastructure a future
    /// consumer could also write to.
    Unrecognized,
}

fn field_uuid(payload: &serde_json::Value, key: &str) -> Option<Uuid> {
    payload.get(key).and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok())
}

pub struct NotificationDispatcher<'a> {
    attempts: &'a dyn NotificationAttemptRepository,
    volunteers: &'a dyn VolunteerSummaryQuery,
    assignments: &'a dyn AssignmentRecipientQuery,
    hour_entries: &'a dyn HourEntryRecipientQuery,
    email: &'a dyn EmailProvider,
    #[allow(dead_code)]
    discord: &'a dyn DiscordDmSender,
}

impl<'a> NotificationDispatcher<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        attempts: &'a dyn NotificationAttemptRepository,
        volunteers: &'a dyn VolunteerSummaryQuery,
        assignments: &'a dyn AssignmentRecipientQuery,
        hour_entries: &'a dyn HourEntryRecipientQuery,
        email: &'a dyn EmailProvider,
        discord: &'a dyn DiscordDmSender,
    ) -> Self {
        Self {
            attempts,
            volunteers,
            assignments,
            hour_entries,
            email,
            discord,
        }
    }

    /// Resolves an outbox row's `event_type`/`payload` into
    /// `(TriggerType, recipient, trigger-specific template fields)`.
    /// Returns `Ok(None)` for an unrecognized `event_type`.
    async fn resolve(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        row: &OutboxRow,
    ) -> Result<Option<(TriggerType, VolunteerId, TemplateData)>, NotificationError> {
        match row.event_type.as_str() {
            "volunteer_onboarded" => {
                let Some(volunteer_id) = field_uuid(&row.payload, "volunteer_id") else {
                    return Ok(None);
                };
                Ok(Some((TriggerType::SignupConfirmation, kernel::Id::from_uuid(volunteer_id), TemplateData::new())))
            }
            "assignment_approved" => {
                let Some(assignment_id) = field_uuid(&row.payload, "assignment_id") else {
                    return Ok(None);
                };
                let recipient = self.assignments.recipient_for_assignment(tx, assignment_id).await?;
                Ok(recipient.map(|r| {
                    (
                        TriggerType::AssignmentApproved,
                        r.volunteer_id,
                        TemplateData::new().insert("project_name", r.project_name),
                    )
                }))
            }
            "hours_approved" => {
                let Some(hour_entry_id) = field_uuid(&row.payload, "hour_entry_id") else {
                    return Ok(None);
                };
                let recipient = self.hour_entries.recipient_for_hour_entry(tx, hour_entry_id).await?;
                Ok(recipient.map(|r| {
                    (
                        TriggerType::HoursApproved,
                        r.volunteer_id,
                        TemplateData::new().insert("hours", r.hours.to_string()).insert("date", r.date.to_string()),
                    )
                }))
            }
            "verification_letter_ready" => {
                let Some(volunteer_id) = field_uuid(&row.payload, "volunteer_id") else {
                    return Ok(None);
                };
                let range_start = row.payload.get("range_start").and_then(|v| v.as_str()).unwrap_or_default();
                let range_end = row.payload.get("range_end").and_then(|v| v.as_str()).unwrap_or_default();
                Ok(Some((
                    TriggerType::VerificationLetterReady,
                    kernel::Id::from_uuid(volunteer_id),
                    TemplateData::new().insert("range_start", range_start).insert("range_end", range_end),
                )))
            }
            _ => Ok(None),
        }
    }

    fn email_template(trigger_type: TriggerType) -> EmailTemplate {
        match trigger_type {
            TriggerType::SignupConfirmation => EmailTemplate::SignupConfirmation,
            TriggerType::AssignmentApproved => EmailTemplate::AssignmentApproved,
            TriggerType::HoursApproved => EmailTemplate::HoursApproved,
            TriggerType::MeetingReminder => EmailTemplate::MeetingReminder,
            TriggerType::VerificationLetterReady => EmailTemplate::VerificationLetterReady,
        }
    }

    /// Dispatches one outbox-sourced trigger (1-3, and 5's direct
    /// write). Idempotent: a row already reflected in
    /// `notification_attempt` (matched on `source_event_id`) is a no-op.
    pub async fn dispatch_outbox_row(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        row: &OutboxRow,
    ) -> Result<DispatchOutcome, NotificationError> {
        if self.attempts.exists_for_source_event(tx, row.id).await? {
            return Ok(DispatchOutcome::AlreadyHandled);
        }

        let Some((trigger_type, recipient_id, mut data)) = self.resolve(tx, row).await? else {
            return Ok(DispatchOutcome::Unrecognized);
        };

        let Some(contact) = self.volunteers.contact_info(tx, recipient_id).await? else {
            let attempt = NotificationAttempt::failed(
                trigger_type,
                recipient_id,
                Channel::Email,
                Some(row.id),
                None,
                None,
                "recipient volunteer not found".to_string(),
            );
            self.attempts.save(tx, &attempt).await?;
            return Ok(DispatchOutcome::RecipientNotFound);
        };
        data = data.insert("name", contact.name);

        let outcome = self.email.send(&contact.email, Self::email_template(trigger_type), data).await;
        self.record_email_outcome(tx, trigger_type, recipient_id, Some(row.id), None, None, outcome).await
    }

    /// Dispatches the time-sourced meeting-reminder trigger (4) for one
    /// `(recipient, project, next_occurrence_at)` tuple -- the caller
    /// (`bin/send_meeting_reminders.rs`) iterates every attendee of
    /// every occurrence `UpcomingEventOccurrencesQuery` returns and
    /// calls this once per recipient.
    pub async fn dispatch_meeting_reminder(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient_id: VolunteerId,
        project_id: ProjectId,
        project_name: &str,
        next_occurrence_at: DateTime<Utc>,
    ) -> Result<DispatchOutcome, NotificationError> {
        if self.attempts.exists_for_occurrence(tx, recipient_id, project_id, next_occurrence_at).await? {
            return Ok(DispatchOutcome::AlreadyHandled);
        }

        let Some(contact) = self.volunteers.contact_info(tx, recipient_id).await? else {
            let attempt = NotificationAttempt::failed(
                TriggerType::MeetingReminder,
                recipient_id,
                Channel::Email,
                None,
                Some(project_id),
                Some(next_occurrence_at),
                "recipient volunteer not found".to_string(),
            );
            self.attempts.save(tx, &attempt).await?;
            return Ok(DispatchOutcome::RecipientNotFound);
        };
        let data = TemplateData::new()
            .insert("name", contact.name)
            .insert("project_name", project_name)
            .insert("next_occurrence_at", next_occurrence_at.to_rfc3339());

        let outcome = self.email.send(&contact.email, EmailTemplate::MeetingReminder, data).await;
        self.record_email_outcome(
            tx,
            TriggerType::MeetingReminder,
            recipient_id,
            None,
            Some(project_id),
            Some(next_occurrence_at),
            outcome,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_email_outcome(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        trigger_type: TriggerType,
        recipient_id: VolunteerId,
        source_event_id: Option<Uuid>,
        project_id: Option<ProjectId>,
        next_occurrence_at: Option<DateTime<Utc>>,
        outcome: Result<ProviderMessageId, EmailError>,
    ) -> Result<DispatchOutcome, NotificationError> {
        let (attempt, dispatch_outcome) = match outcome {
            Ok(_message_id) => (
                NotificationAttempt::sent(trigger_type, recipient_id, Channel::Email, source_event_id, project_id, next_occurrence_at),
                DispatchOutcome::Sent,
            ),
            Err(err) => (
                NotificationAttempt::failed(
                    trigger_type,
                    recipient_id,
                    Channel::Email,
                    source_event_id,
                    project_id,
                    next_occurrence_at,
                    err.0.clone(),
                ),
                DispatchOutcome::Failed(err.0),
            ),
        };
        self.attempts.save(tx, &attempt).await?;
        Ok(dispatch_outcome)
    }
}
