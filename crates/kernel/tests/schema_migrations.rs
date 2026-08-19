//! Prompt 1.2 exit criteria, exercised against a real, disposable Postgres
//! (via testcontainers): migrations are reproducible from a clean
//! database; the event-hours trigger on `hour_entry` blocks an
//! attendee-mode assignment even via raw SQL that bypasses the Rust
//! domain layer entirely; and RLS, enforced as the non-owner `app_user`
//! role (never the migration-owner role), actually isolates volunteers
//! from each other's data while still permitting admin/lead access.

use sqlx::{Executor, PgPool};
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

struct TestDb {
    // Keep the container alive for the test's duration.
    _container: testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    owner_pool: PgPool,
    host_port: u16,
}

async fn setup() -> TestDb {
    let container = Postgres::default()
        .start()
        .await
        .expect("failed to start postgres container");
    let host_port = container
        .get_host_port_ipv4(5432)
        .await
        .expect("failed to get mapped port");
    let url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");

    let owner_pool = PgPool::connect(&url)
        .await
        .expect("failed to connect to postgres");

    // Reproducible from a clean database: this is the entire migration
    // set, run against a container that has never seen this schema.
    MIGRATOR
        .run(&owner_pool)
        .await
        .expect("migrations must apply cleanly to a fresh database");

    TestDb {
        _container: container,
        owner_pool,
        host_port,
    }
}

async fn app_user_pool(host_port: u16) -> PgPool {
    let url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    PgPool::connect(&url)
        .await
        .expect("failed to connect as app_user")
}

async fn set_actor(pool: &PgPool, actor: Uuid) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    let mut conn = pool.acquire().await.expect("acquire connection");
    conn.execute(
        sqlx::query("SELECT set_config('app.current_user_id', $1, false)").bind(actor.to_string()),
    )
    .await
    .expect("set actor");
    conn
}

#[tokio::test]
async fn migrations_are_reproducible_from_a_clean_database() {
    // setup() itself runs the full migration set against a brand-new
    // container; a second run proves idempotency of the *process* (the
    // migrator's own tracking table), matching the Phase 1 exit criterion
    // literally.
    let db = setup().await;
    let again = MIGRATOR.run(&db.owner_pool).await;
    assert!(
        again.is_ok(),
        "re-running the migrator against an already-migrated database must be a no-op, not an error"
    );
}

#[tokio::test]
async fn event_hours_trigger_blocks_attendee_mode_hour_entry_via_raw_sql() {
    let db = setup().await;
    let owner = &db.owner_pool;

    let volunteer_id: Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone) values ('Host', 'host@example.org', 'UTC') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    let attendee_id: Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone) values ('Attendee', 'attendee@example.org', 'UTC') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    let event_project_id: Uuid = sqlx::query_scalar(
        "insert into project (name, type, next_occurrence_at) \
         values ('Weekly Meetup', 'event', now() + interval '7 days') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(event_project_id)
        .bind(volunteer_id)
        .execute(owner)
        .await
        .unwrap();

    // Contributor-mode assignment (the event's own host).
    let contributor_assignment_id: Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Host', 'contributor', 'approved') returning id",
    )
    .bind(volunteer_id)
    .bind(event_project_id)
    .fetch_one(owner)
    .await
    .unwrap();

    // Attendee-mode assignment (an ordinary event attendee).
    let attendee_assignment_id: Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Attendee', 'attendee', 'approved') returning id",
    )
    .bind(attendee_id)
    .bind(event_project_id)
    .fetch_one(owner)
    .await
    .unwrap();

    // The invalid case: an hour_entry against an Attendee-mode assignment,
    // inserted via raw SQL, bypassing the Rust HourEntry::log constructor
    // entirely. The trigger alone must block this.
    let blocked = sqlx::query(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description) \
         values ($1, $2, current_date, 1.0, 'attending the meetup')",
    )
    .bind(attendee_id)
    .bind(attendee_assignment_id)
    .execute(owner)
    .await;

    assert!(
        blocked.is_err(),
        "the trigger must reject an hour_entry against an attendee-mode assignment"
    );
    let err = blocked.unwrap_err().to_string();
    assert!(
        err.contains("contributor-mode"),
        "unexpected error message, trigger may not be firing as expected: {err}"
    );

    // The valid case: the event's host (Contributor mode) can log hours.
    let allowed = sqlx::query(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description) \
         values ($1, $2, current_date, 2.0, 'prepped and ran the meetup')",
    )
    .bind(volunteer_id)
    .bind(contributor_assignment_id)
    .execute(owner)
    .await;

    assert!(
        allowed.is_ok(),
        "a contributor-mode (host) assignment must be allowed to log hours: {:?}",
        allowed.err()
    );
}

#[tokio::test]
async fn rls_isolates_volunteers_under_the_non_owner_app_role() {
    let db = setup().await;
    let owner = &db.owner_pool;

    let volunteer_a: Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone, role, status) \
         values ('Volunteer A', 'a@example.org', 'UTC', 'volunteer', 'approved') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    let volunteer_b: Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone, role, status) \
         values ('Volunteer B', 'b@example.org', 'UTC', 'volunteer', 'approved') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    let admin: Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone, role, status) \
         values ('Admin', 'admin@example.org', 'UTC', 'admin', 'approved') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    let project_id: Uuid = sqlx::query_scalar(
        "insert into project (name, type) values ('Website Revamp', 'project') returning id",
    )
    .fetch_one(owner)
    .await
    .unwrap();

    let assignment_id: Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Contributor', 'contributor', 'approved') returning id",
    )
    .bind(volunteer_a)
    .bind(project_id)
    .fetch_one(owner)
    .await
    .unwrap();

    sqlx::query(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description) \
         values ($1, $2, current_date, 3.0, 'built the homepage')",
    )
    .bind(volunteer_a)
    .bind(assignment_id)
    .execute(owner)
    .await
    .unwrap();

    let app_pool = app_user_pool(db.host_port).await;

    // Confirm app_user is genuinely not the table owner (the crux of
    // ADR-0004's requirement) — table owners bypass RLS regardless of
    // policy definitions.
    let owner_name: String = sqlx::query_scalar(
        "select pg_catalog.pg_get_userbyid(relowner) from pg_class where relname = 'hour_entry'",
    )
    .fetch_one(owner)
    .await
    .unwrap();
    assert_ne!(
        owner_name, "app_user",
        "app_user must not own hour_entry (or any RLS-protected table) — \
         table owners silently bypass RLS regardless of policy definitions"
    );

    // Volunteer B, scoped as themselves, must not see Volunteer A's hours.
    let mut conn_b = set_actor(&app_pool, volunteer_b).await;
    let visible_to_b: Vec<Uuid> = sqlx::query_scalar("select id from hour_entry")
        .fetch_all(&mut *conn_b)
        .await
        .unwrap();
    assert!(
        visible_to_b.is_empty(),
        "volunteer B must not see volunteer A's hour_entry rows via RLS"
    );

    // Volunteer A, scoped as themselves, sees their own entry.
    let mut conn_a = set_actor(&app_pool, volunteer_a).await;
    let visible_to_a: Vec<Uuid> = sqlx::query_scalar("select id from hour_entry")
        .fetch_all(&mut *conn_a)
        .await
        .unwrap();
    assert_eq!(
        visible_to_a.len(),
        1,
        "volunteer A must see their own hour_entry row"
    );

    // Admin, scoped as themselves, sees every entry regardless of owner.
    let mut conn_admin = set_actor(&app_pool, admin).await;
    let visible_to_admin: Vec<Uuid> = sqlx::query_scalar("select id from hour_entry")
        .fetch_all(&mut *conn_admin)
        .await
        .unwrap();
    assert_eq!(
        visible_to_admin.len(),
        1,
        "admin must see every hour_entry row regardless of whose it is"
    );

    // Volunteer B cannot forge an hour_entry for volunteer A either.
    let forged = sqlx::query(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description) \
         values ($1, $2, current_date, 5.0, 'not mine to log')",
    )
    .bind(volunteer_a)
    .bind(assignment_id)
    .execute(&mut *conn_b)
    .await;
    assert!(
        forged.is_err(),
        "volunteer B must not be able to insert an hour_entry on volunteer A's behalf"
    );
}
