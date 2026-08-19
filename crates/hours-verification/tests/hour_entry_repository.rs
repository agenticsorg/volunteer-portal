//! Prompt 4.1 exit criteria, integration half: `HourEntry::log`, driven
//! through the real `SqlxAssignmentSnapshotQuery` (not a hand-built
//! `AssignmentSnapshot`), refuses an `Attendee`-mode assignment and
//! succeeds against a `Contributor`-mode one -- both directions of the
//! event-hours invariant, proven against the actual `assignment` table's
//! `participation_mode` column, not just pure in-memory domain logic
//! (already covered by `hour_entry.rs`'s unit tests). The Postgres
//! trigger's independent enforcement of the same rule (Prompt 1.2) is
//! already exercised by
//! `kernel::tests::event_hours_trigger_blocks_attendee_mode_hour_entry_via_raw_sql`
//! -- this file is the Rust-layer half specifically.

use chrono::NaiveDate;
use hours_verification::{
    AssignmentSnapshotQuery, HourEntry, HourEntryError, HourEntryRepository, Hours,
    SqlxAssignmentSnapshotQuery, SqlxHourEntryRepository,
};
use kernel::ScopedDb;
use rust_decimal::Decimal;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

async fn scoped_db() -> (
    testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    ScopedDb,
    PgPool,
) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();

    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    (container, ScopedDb::new(app_pool), owner_pool)
}

async fn seed_volunteer(owner_pool: &PgPool, role: &str) -> Uuid {
    sqlx::query_scalar(
        "insert into volunteer (name, email, timezone, role, status) \
         values ('Test', $1, 'UTC', $2, 'approved') returning id",
    )
    .bind(format!("{}@example.org", Uuid::new_v4()))
    .bind(role)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn hour_entry_log_refuses_an_attendee_mode_assignment_snapshot() {
    let (_container, db, owner_pool) = scoped_db().await;

    let host = seed_volunteer(&owner_pool, "lead").await;
    let attendee = seed_volunteer(&owner_pool, "volunteer").await;

    let event_project_id: Uuid = sqlx::query_scalar(
        "insert into project (name, type, next_occurrence_at) \
         values ('Weekly Meetup', 'event', now() + interval '7 days') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(event_project_id)
        .bind(host)
        .execute(&owner_pool)
        .await
        .unwrap();

    let attendee_assignment_id: Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Attendee', 'attendee', 'approved') returning id",
    )
    .bind(attendee)
    .bind(event_project_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let mut tx = db.begin_scoped(attendee).await.unwrap();
    let query = SqlxAssignmentSnapshotQuery;
    let snapshot = query
        .snapshot(&mut tx, kernel::Id::from_uuid(attendee_assignment_id))
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();

    let err = HourEntry::log(
        &snapshot,
        NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
        Hours::new(Decimal::from(2)).unwrap(),
        "Attended the meetup".to_string(),
    )
    .unwrap_err();
    assert_eq!(err, HourEntryError::AssignmentNotEligibleForHours);
}

#[tokio::test]
async fn hour_entry_log_succeeds_and_round_trips_for_a_contributor_mode_event_lead_assignment() {
    let (_container, db, owner_pool) = scoped_db().await;

    let host = seed_volunteer(&owner_pool, "lead").await;

    let event_project_id: Uuid = sqlx::query_scalar(
        "insert into project (name, type, next_occurrence_at) \
         values ('Weekly Meetup', 'event', now() + interval '7 days') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(event_project_id)
        .bind(host)
        .execute(&owner_pool)
        .await
        .unwrap();

    let host_assignment_id: Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Host', 'contributor', 'approved') returning id",
    )
    .bind(host)
    .bind(event_project_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let mut tx = db.begin_scoped(host).await.unwrap();
    let query = SqlxAssignmentSnapshotQuery;
    let snapshot = query
        .snapshot(&mut tx, kernel::Id::from_uuid(host_assignment_id))
        .await
        .unwrap()
        .unwrap();

    let mut entry = HourEntry::log(
        &snapshot,
        NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
        Hours::new(Decimal::from(3)).unwrap(),
        "Led setup and teardown".to_string(),
    )
    .unwrap();

    let repo = SqlxHourEntryRepository;
    let events = repo.save(&mut tx, &mut entry).await.unwrap();
    tx.commit().await.unwrap();

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type(), "hours_logged");

    let mut read_tx = db.begin_scoped(host).await.unwrap();
    let persisted = repo
        .find_by_id(&mut read_tx, entry.id())
        .await
        .unwrap()
        .unwrap();
    read_tx.commit().await.unwrap();

    assert_eq!(persisted.hours(), entry.hours());
    assert_eq!(persisted.status(), entry.status());
    assert_eq!(persisted.description(), "Led setup and teardown");
}
