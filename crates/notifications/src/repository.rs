use async_trait::async_trait;
use chrono::{DateTime, Utc};
use kernel::{Id, ProjectId, RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::notification_attempt::{AttemptStatus, Channel, NotificationAttempt, TriggerType};

#[async_trait]
pub trait NotificationAttemptRepository: Send + Sync {
    async fn save(&self, tx: &mut Transaction<'_, Postgres>, attempt: &NotificationAttempt) -> Result<(), RepoError>;

    /// Admin/debugging visibility (notifications.md: "an admin
    /// investigating 'did volunteer X get their letter email' queries
    /// Notifications").
    async fn find_by_recipient(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient: VolunteerId,
    ) -> Result<Vec<NotificationAttempt>, RepoError>;

    /// Idempotency check for the three outbox-sourced triggers (and the
    /// write made for trigger 5) -- `true` only once a `Sent` attempt
    /// exists; a prior `Failed` attempt does not count, so a redelivered
    /// outbox row is retried, not skipped (build-roadmap.md's Phase 7
    /// exit criterion).
    async fn exists_for_source_event(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        source_event_id: Uuid,
    ) -> Result<bool, RepoError>;

    /// Idempotency check for the time-sourced meeting-reminder trigger --
    /// same `Sent`-only semantics as `exists_for_source_event`.
    async fn exists_for_occurrence(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient: VolunteerId,
        project_id: ProjectId,
        next_occurrence_at: DateTime<Utc>,
    ) -> Result<bool, RepoError>;
}

pub struct SqlxNotificationAttemptRepository;

#[async_trait]
impl NotificationAttemptRepository for SqlxNotificationAttemptRepository {
    async fn save(&self, tx: &mut Transaction<'_, Postgres>, attempt: &NotificationAttempt) -> Result<(), RepoError> {
        sqlx::query!(
            r#"insert into notification_attempt
                   (id, trigger_type, recipient_id, channel, source_event_id, project_id,
                    next_occurrence_at, status, attempted_at, error)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"#,
            attempt.id().as_uuid(),
            attempt.trigger_type().as_str(),
            attempt.recipient().as_uuid(),
            attempt.channel().as_str(),
            attempt.source_event_id(),
            attempt.project_id().map(|id| id.as_uuid()),
            attempt.next_occurrence_at(),
            attempt.status().as_str(),
            attempt.attempted_at(),
            attempt.error(),
        )
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    async fn find_by_recipient(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient: VolunteerId,
    ) -> Result<Vec<NotificationAttempt>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, trigger_type, recipient_id, channel, source_event_id, project_id,
                      next_occurrence_at as "next_occurrence_at: DateTime<Utc>",
                      status, attempted_at as "attempted_at: DateTime<Utc>", error
               from notification_attempt
               where recipient_id = $1
               order by attempted_at desc"#,
            recipient.as_uuid(),
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                NotificationAttempt::from_persisted(
                    Id::from_uuid(r.id),
                    TriggerType::parse(&r.trigger_type).expect("trigger_type column must be a valid TriggerType"),
                    Id::from_uuid(r.recipient_id),
                    Channel::parse(&r.channel).expect("channel column must be a valid Channel"),
                    r.source_event_id,
                    r.project_id.map(Id::from_uuid),
                    r.next_occurrence_at,
                    AttemptStatus::parse(&r.status).expect("status column must be a valid AttemptStatus"),
                    r.attempted_at,
                    r.error,
                )
            })
            .collect())
    }

    async fn exists_for_source_event(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        source_event_id: Uuid,
    ) -> Result<bool, RepoError> {
        let exists: bool = sqlx::query_scalar!(
            r#"select exists(
                   select 1 from notification_attempt
                   where source_event_id = $1 and status = 'sent'
               ) as "exists!""#,
            source_event_id,
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(exists)
    }

    async fn exists_for_occurrence(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient: VolunteerId,
        project_id: ProjectId,
        next_occurrence_at: DateTime<Utc>,
    ) -> Result<bool, RepoError> {
        let exists: bool = sqlx::query_scalar!(
            r#"select exists(
                   select 1 from notification_attempt
                   where trigger_type = 'meeting_reminder'
                     and recipient_id = $1
                     and project_id = $2
                     and next_occurrence_at = $3
                     and status = 'sent'
               ) as "exists!""#,
            recipient.as_uuid(),
            project_id.as_uuid(),
            next_occurrence_at,
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(exists)
    }
}
