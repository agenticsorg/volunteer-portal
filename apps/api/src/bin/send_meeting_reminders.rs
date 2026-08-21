//! Prompt 7.1 trigger 4 (meeting reminder) -- the time-sourced trigger,
//! not outbox-driven. Runs `UpcomingEventOccurrencesQuery::find_occurring_within`
//! once against a fixed lookahead window, sends a reminder to every
//! attendee of every returned occurrence, and exits -- a Fly.io
//! Machines/cron-equivalent scheduled job (ADR-0012, e.g. hourly), the
//! same shape as `process_notification_outbox.rs` and Prompt 5.1's
//! `reconcile_discord_roles.rs`.
//!
//! Requires `EMAIL_FROM_ADDRESS` and (depending on `EMAIL_PROVIDER`,
//! default `postmark`) either `POSTMARK_SERVER_TOKEN` or
//! `RESEND_API_KEY` -- **blocked on credentials** in this environment,
//! same as `process_notification_outbox.rs`. The code path is real and
//! ready to run once those are provided; this is not a stub.

use api::assignment_recipient_adapter::ProjectsAssignmentsRecipientAdapter;
use api::hour_entry_recipient_adapter::HoursVerificationRecipientAdapter;
use api::postmark_email_provider::PostmarkEmailProvider;
use api::resend_email_provider::ResendEmailProvider;
use chrono::Duration;
use identity_access::SqlxVolunteerSummaryQuery;
use kernel::ScopedDb;
use notifications::{
    DiscordDeliveryError, DiscordDmSender, DispatchOutcome, DmContent, EmailProvider,
    NotificationDispatcher, SqlxNotificationAttemptRepository,
};
use projects_assignments::{SqlxProjectRepository, UpcomingEventOccurrencesQuery};
use sqlx::PgPool;

/// notifications.md's example lookahead window ("e.g. 24h") -- reminds
/// attendees of anything occurring in the next day, re-run hourly (or
/// however often the operator schedules this job); `exists_for_occurrence`
/// is what keeps repeated runs from re-sending within that window, not
/// this constant.
const LOOKAHEAD_HOURS: i64 = 24;

struct NullDiscordDmSender;

#[async_trait::async_trait]
impl DiscordDmSender for NullDiscordDmSender {
    async fn send_dm(&self, _discord_user_id: &str, _message: DmContent) -> Result<(), DiscordDeliveryError> {
        Err(DiscordDeliveryError(
            "Discord DM sending is not wired into the v1 dispatch flow".to_string(),
        ))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("APP_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("APP_DATABASE_URL or DATABASE_URL must be set");
    let pool = PgPool::connect(&database_url).await?;
    let db = ScopedDb::new(pool);

    let from_address = std::env::var("EMAIL_FROM_ADDRESS").expect("EMAIL_FROM_ADDRESS must be set");
    let provider_kind = std::env::var("EMAIL_PROVIDER").unwrap_or_else(|_| "postmark".to_string());
    let email_provider: Box<dyn EmailProvider> = match provider_kind.as_str() {
        "resend" => {
            let api_key =
                std::env::var("RESEND_API_KEY").expect("RESEND_API_KEY must be set when EMAIL_PROVIDER=resend");
            Box::new(ResendEmailProvider::new(&api_key, from_address))
        }
        _ => {
            let server_token = std::env::var("POSTMARK_SERVER_TOKEN")
                .expect("POSTMARK_SERVER_TOKEN must be set (or set EMAIL_PROVIDER=resend and RESEND_API_KEY)");
            Box::new(PostmarkEmailProvider::new(server_token, from_address))
        }
    };

    let attempts = SqlxNotificationAttemptRepository;
    let volunteers = SqlxVolunteerSummaryQuery;
    let assignments = ProjectsAssignmentsRecipientAdapter;
    let hour_entries = HoursVerificationRecipientAdapter;
    let discord = NullDiscordDmSender;
    let dispatcher = NotificationDispatcher::new(
        &attempts,
        &volunteers,
        &assignments,
        &hour_entries,
        email_provider.as_ref(),
        &discord,
    );

    let projects = SqlxProjectRepository;
    let mut query_tx = db.begin_system_scoped().await?;
    let occurrences = projects
        .find_occurring_within(&mut query_tx, Duration::hours(LOOKAHEAD_HOURS))
        .await?;
    query_tx.commit().await?;

    let (mut sent, mut failed, mut already_handled) = (0usize, 0usize, 0usize);

    for occurrence in &occurrences {
        for attendee_id in &occurrence.attendee_ids {
            let mut tx = db.begin_system_scoped().await?;
            let outcome = dispatcher
                .dispatch_meeting_reminder(
                    &mut tx,
                    *attendee_id,
                    occurrence.project_id,
                    &occurrence.project_name,
                    occurrence.next_occurrence_at,
                )
                .await?;
            tx.commit().await?;

            match outcome {
                DispatchOutcome::Sent => sent += 1,
                DispatchOutcome::AlreadyHandled => already_handled += 1,
                DispatchOutcome::Failed(_) | DispatchOutcome::RecipientNotFound => failed += 1,
                DispatchOutcome::Unrecognized => {
                    unreachable!("dispatch_meeting_reminder never returns Unrecognized")
                }
            }
        }
    }

    tracing::info!(
        occurrences = occurrences.len(),
        sent,
        failed,
        already_handled,
        "meeting reminder run complete",
    );
    Ok(())
}
