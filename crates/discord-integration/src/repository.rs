use async_trait::async_trait;
use kernel::RepoError;
use sqlx::{Postgres, Transaction};

use crate::reconciler::ReconcileReport;

/// Operational log for reconcile runs -- not `audit_log` (see
/// `events.rs`'s `DiscordRoleReconciled` doc comment). `discord_link` and
/// its `DiscordLinkRepository` (the other table this context owns, per
/// discord-integration.md's "Repository/port shapes") are built in
/// Prompt 5.2 alongside `LinkCommandHandler`; the table itself was
/// created now (migration 20260819000009) since it shares a migration
/// with this one, but its Rust repository is out of this prompt's scope.
#[async_trait]
pub trait ReconcileRunLogRepository: Send + Sync {
    async fn record(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        report: &ReconcileReport,
    ) -> Result<(), RepoError>;

    async fn latest(&self, tx: &mut Transaction<'_, Postgres>) -> Result<Option<ReconcileReport>, RepoError>;
}

pub struct SqlxReconcileRunLogRepository;

#[async_trait]
impl ReconcileRunLogRepository for SqlxReconcileRunLogRepository {
    async fn record(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        report: &ReconcileReport,
    ) -> Result<(), RepoError> {
        sqlx::query!(
            r#"insert into reconcile_run_log (id, desynced_count, corrected_count, failed_count, ran_at)
               values ($1, $2, $3, $4, $5)"#,
            report.run_id,
            report.desynced_count as i32,
            report.corrected_count as i32,
            report.failed_count as i32,
            report.ran_at,
        )
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    async fn latest(&self, tx: &mut Transaction<'_, Postgres>) -> Result<Option<ReconcileReport>, RepoError> {
        let row = sqlx::query!(
            r#"select id, desynced_count, corrected_count, failed_count,
                      ran_at as "ran_at: chrono::DateTime<chrono::Utc>"
               from reconcile_run_log order by ran_at desc limit 1"#
        )
        .fetch_optional(&mut **tx)
        .await?;

        Ok(row.map(|r| ReconcileReport {
            run_id: r.id,
            desynced_count: r.desynced_count as usize,
            corrected_count: r.corrected_count as usize,
            failed_count: r.failed_count as usize,
            ran_at: r.ran_at,
            unmapped_roles: Vec::new(),
        }))
    }
}

