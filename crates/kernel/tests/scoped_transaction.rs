//! Integration test for `ScopedDb::begin_scoped` (Prompt 1.1 exit
//! criterion): proves that two concurrent scoped transactions with
//! different `user_id`s cannot see each other's `SET LOCAL`-scoped value,
//! against a real Postgres (via testcontainers), per ADR-0004.

use kernel::ScopedDb;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use uuid::Uuid;

#[tokio::test]
async fn concurrent_scoped_transactions_do_not_leak_current_user_id() {
    let container = Postgres::default()
        .start()
        .await
        .expect("failed to start postgres container");
    let host_port = container
        .get_host_port_ipv4(5432)
        .await
        .expect("failed to get mapped port");
    let url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");

    let pool = PgPool::connect(&url)
        .await
        .expect("failed to connect to postgres");
    let db = ScopedDb::new(pool);

    let user_a = Uuid::new_v4();
    let user_b = Uuid::new_v4();

    // Two separate scoped transactions, opened from two separate pooled
    // connections, each with its own SET LOCAL-scoped identity.
    let mut tx_a = db.begin_scoped(user_a).await.expect("begin_scoped A");
    let mut tx_b = db.begin_scoped(user_b).await.expect("begin_scoped B");

    let seen_in_a: String =
        sqlx::query_scalar("SELECT current_setting('app.current_user_id', true)")
            .fetch_one(&mut *tx_a)
            .await
            .expect("read current_setting in tx_a");
    let seen_in_b: String =
        sqlx::query_scalar("SELECT current_setting('app.current_user_id', true)")
            .fetch_one(&mut *tx_b)
            .await
            .expect("read current_setting in tx_b");

    assert_eq!(seen_in_a, user_a.to_string());
    assert_eq!(seen_in_b, user_b.to_string());
    assert_ne!(
        seen_in_a, seen_in_b,
        "two concurrent scoped transactions must not see each other's \
         app.current_user_id value"
    );

    tx_a.commit().await.expect("commit tx_a");
    tx_b.commit().await.expect("commit tx_b");

    // After commit (transaction ended), a fresh, unscoped connection must
    // see no lingering value — proving the setting really was SET LOCAL
    // (transaction-scoped), not a plain SET that would have persisted on
    // whichever pooled connection each transaction happened to use.
    let mut fresh = db.pool().acquire().await.expect("acquire fresh connection");
    let after_commit: Option<String> =
        sqlx::query_scalar("SELECT current_setting('app.current_user_id', true)")
            .fetch_one(&mut *fresh)
            .await
            .expect("read current_setting after commit");
    assert!(
        after_commit.as_deref().unwrap_or("").is_empty(),
        "app.current_user_id must not persist beyond the transaction that set it \
         (found {after_commit:?}) — a plain SET would leak identity across pooled \
         connections under transaction pooling, per ADR-0004"
    );
}
