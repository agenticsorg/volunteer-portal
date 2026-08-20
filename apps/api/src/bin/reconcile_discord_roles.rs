//! The Discord role-sync reconcile job (Prompt 5.1, ADR-0008): a
//! scheduled, one-shot process, not a persistent Gateway bot -- run as a
//! Fly.io Machines/cron-equivalent scheduled job (ADR-0012), invoked
//! however often the operator configures (concept.md doesn't mandate a
//! specific interval; discord-integration.md's outbox-consumption note
//! says a `RoleChanged`/`AssignmentApproved`/`VolunteerApproved` event
//! should only ever debounce the *next scheduled* run sooner, never
//! trigger a synchronous call -- that debounce wiring is Phase 7's
//! notifications outbox, not built yet, so today this binary simply runs
//! reconcile() once per invocation and exits).
//!
//! Requires `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` -- **blocked on
//! credentials** in this environment (no live Discord bot application
//! configured yet). The code path is real and ready to run once those
//! are provided; this is not a stub.

use api::active_membership_adapter::ProjectsAssignmentsActiveMembershipAdapter;
use discord_integration::{
    IdentityAccessApprovedVolunteersQuery, ReconcileRunLogRepository, RoleReconciler,
    SqlxDiscordRoleMapping, SqlxReconcileRunLogRepository, TwilightDiscordClient,
};
use identity_access::SqlxVolunteerSummaryQuery;
use kernel::ScopedDb;
use sqlx::PgPool;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("APP_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("APP_DATABASE_URL or DATABASE_URL must be set");
    let pool = PgPool::connect(&database_url).await?;
    let db = ScopedDb::new(pool.clone());

    let bot_token = std::env::var("DISCORD_BOT_TOKEN").expect("DISCORD_BOT_TOKEN must be set");
    let guild_id: u64 = std::env::var("DISCORD_GUILD_ID")
        .expect("DISCORD_GUILD_ID must be set")
        .parse()
        .expect("DISCORD_GUILD_ID must be a valid Discord guild snowflake");

    let role_mapping = SqlxDiscordRoleMapping::load(&pool).await?;
    let discord_client = TwilightDiscordClient::new(bot_token, guild_id);

    let reconciler = RoleReconciler::new(
        IdentityAccessApprovedVolunteersQuery::new(SqlxVolunteerSummaryQuery),
        ProjectsAssignmentsActiveMembershipAdapter,
        role_mapping,
        discord_client,
    );

    // System-actor transaction (kernel::ScopedDb::begin_system_scoped,
    // Prompt 5.1) -- this job has no corresponding `volunteer` row.
    let mut tx = db.begin_system_scoped().await?;
    let report = reconciler.reconcile(&mut tx).await?;

    let run_log = SqlxReconcileRunLogRepository;
    run_log.record(&mut tx, &report).await?;
    tx.commit().await?;

    tracing::info!(
        run_id = %report.run_id,
        desynced = report.desynced_count,
        corrected = report.corrected_count,
        failed = report.failed_count,
        unmapped_roles = ?report.unmapped_roles,
        "Discord role reconcile run complete",
    );

    Ok(())
}
