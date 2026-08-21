//! Prompt 7.1: polls `domain_event_outbox` once, dispatches every
//! currently-unprocessed row, and exits -- a Fly.io Machines/cron-
//! equivalent scheduled job (ADR-0012), the same shape as Prompt 5.1's
//! `reconcile_discord_roles.rs`, not a persistent in-process Tokio
//! interval task. Each row gets its own transaction (poll is a separate,
//! short read) so a failure partway through a batch doesn't roll back
//! attempts already recorded for earlier rows in the same run.
//!
//! Requires `EMAIL_FROM_ADDRESS` and (depending on `EMAIL_PROVIDER`,
//! default `postmark`) either `POSTMARK_SERVER_TOKEN` or
//! `RESEND_API_KEY` -- **blocked on credentials** in this environment
//! (no live Postmark/Resend account configured yet). The code path is
//! real and ready to run once those are provided; this is not a stub.

use api::assignment_recipient_adapter::ProjectsAssignmentsRecipientAdapter;
use api::hour_entry_recipient_adapter::HoursVerificationRecipientAdapter;
use api::postmark_email_provider::PostmarkEmailProvider;
use api::resend_email_provider::ResendEmailProvider;
use identity_access::SqlxVolunteerSummaryQuery;
use kernel::{OutboxRepository, ScopedDb, SqlxOutboxRepository};
use notifications::{
    DiscordDeliveryError, DiscordDmSender, DispatchOutcome, DmContent, EmailProvider,
    NotificationDispatcher, SqlxNotificationAttemptRepository,
};
use sqlx::PgPool;

/// One poll tick's ceiling -- keeps each run's wall-clock bounded even
/// if the outbox backs up; a lower-than-usual `sent` count in the
/// tracing summary is the signal to shorten the scheduler interval, not
/// a reason to raise this unboundedly.
const BATCH_LIMIT: i64 = 100;

/// `DiscordDmSender` is required at the type level
/// (`NotificationDispatcher::new`'s signature) but not called by this
/// crate's v1 dispatch flow -- see `notifications::TriggerType`'s doc
/// comment. Matches this codebase's existing "unused but type-required"
/// precedent (`UnusedGoogleOAuthClient`/`UnusedDiscordOAuthClient` in the
/// test suites) rather than requiring Discord credentials this job
/// doesn't otherwise need.
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

    let outbox = SqlxOutboxRepository;
    let mut poll_tx = db.begin_system_scoped().await?;
    let rows = outbox.poll_unprocessed(&mut poll_tx, BATCH_LIMIT).await?;
    poll_tx.commit().await?;

    let (mut sent, mut failed, mut already_handled, mut unrecognized) = (0usize, 0usize, 0usize, 0usize);

    for row in &rows {
        let mut tx = db.begin_system_scoped().await?;
        let outcome = dispatcher.dispatch_outbox_row(&mut tx, row).await?;
        match outcome {
            DispatchOutcome::Sent | DispatchOutcome::AlreadyHandled | DispatchOutcome::Unrecognized => {
                outbox.mark_processed(&mut tx, row.id).await?;
                match outcome {
                    DispatchOutcome::Sent => sent += 1,
                    DispatchOutcome::AlreadyHandled => already_handled += 1,
                    DispatchOutcome::Unrecognized => unrecognized += 1,
                    _ => unreachable!(),
                }
            }
            // Left unprocessed on purpose: the next scheduled run
            // retries these rows (build-roadmap.md's Phase 7 exit
            // criterion -- a failed send is retried, not looped
            // synchronously here).
            DispatchOutcome::Failed(_) | DispatchOutcome::RecipientNotFound => {
                outbox.increment_attempts(&mut tx, row.id).await?;
                failed += 1;
            }
        }
        tx.commit().await?;
    }

    tracing::info!(
        polled = rows.len(),
        sent,
        failed,
        already_handled,
        unrecognized,
        "notification outbox poll complete",
    );
    Ok(())
}
