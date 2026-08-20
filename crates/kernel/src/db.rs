use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::RepoError;

/// The RLS-scoping query. Uses `set_config(setting_name, value, is_local)`
/// with `is_local = true` — the parameterized equivalent of `SET LOCAL`,
/// since a literal `SET LOCAL app.current_user_id = $1` is not valid
/// parameterized SQL. `is_local = true` is non-negotiable per ADR-0004:
/// a plain `SET` (or `is_local = false`) persists for the lifetime of a
/// pooled connection and would leak one request's identity into the next
/// request that reuses the connection under transaction pooling
/// (PgBouncer) — a cross-tenant data leak. `SET LOCAL`/`is_local = true`
/// is scoped to the transaction and is safe under pooling by construction.
const SCOPE_QUERY: &str = "SELECT set_config('app.current_user_id', $1, true)";

/// Wraps the application's connection pool and is the **only** sanctioned
/// way to acquire a transaction anywhere in this codebase (ADR-0004). Every
/// repository trait across every context accepts a caller-supplied
/// `&mut Transaction<'_, Postgres>` (never opens its own connection), and
/// that transaction must always originate from `begin_scoped` so RLS
/// policies referencing `current_setting('app.current_user_id')` see the
/// correct actor for every query in the transaction.
#[derive(Clone)]
pub struct ScopedDb {
    pool: PgPool,
}

impl ScopedDb {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Exposed for migrations and health checks only — request-handling
    /// code must go through `begin_scoped`, never this directly.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Opens a transaction and scopes `app.current_user_id` to it for the
    /// transaction's lifetime only. Every RLS policy on `project`,
    /// `project_lead`, `assignment`, `hour_entry`, and `audit_log`
    /// (Prompt 1.2) reads this session variable via
    /// `current_setting('app.current_user_id')`.
    pub async fn begin_scoped(
        &self,
        user_id: Uuid,
    ) -> Result<Transaction<'static, Postgres>, RepoError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(SCOPE_QUERY)
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }

    /// Opens a transaction for the `System` actor (`ActorId::System`) --
    /// a scheduled job with no corresponding `volunteer` row, e.g. the
    /// Discord role-reconcile job (Prompt 5.1). Deliberately does **not**
    /// call `set_config` at all, leaving `app.current_user_id` unset for
    /// the transaction so `current_actor_id()` resolves `NULL` (its
    /// `nullif(current_setting(..., true), '')` definition already
    /// handles the unset case) -- the same "actor_id is null ... future
    /// System-actor scope" allowance `audit_log`'s own INSERT policy
    /// anticipated back in Prompt 1.4. Every RLS policy a System-actor
    /// job needs to pass must explicitly include `current_actor_id() is
    /// null` as an alternative, the same way `current_actor_role() =
    /// 'admin'` is an alternative elsewhere -- there is no separate
    /// bypass role.
    pub async fn begin_system_scoped(&self) -> Result<Transaction<'static, Postgres>, RepoError> {
        Ok(self.pool.begin().await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_query_uses_set_local_semantics_not_plain_set() {
        let upper = SCOPE_QUERY.to_uppercase();
        assert!(
            upper.contains("SET_CONFIG"),
            "scoped-transaction helper must go through set_config(..., true), \
             not a bare SET statement"
        );
        assert!(
            SCOPE_QUERY.trim_end().ends_with(", true)"),
            "set_config's is_local argument must be `true` (SET LOCAL \
             semantics), never `false` (plain SET semantics) — a plain SET \
             leaks identity across pooled connections under transaction \
             pooling, per ADR-0004"
        );
    }
}
