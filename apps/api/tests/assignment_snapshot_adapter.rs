//! Prompt 4.1 exit criteria, integration half (moved here per the
//! 2026-08-19 architecture-consistency amendment to hours-verification.md:
//! `AssignmentSnapshotQuery`'s concrete implementation lives in `apps/api`,
//! not `hours-verification`, since `hours-verification` cannot depend on
//! `projects-assignments`). `ProjectsAssignmentsSnapshotAdapter` translates
//! a real `projects_assignments::Assignment` -- seeded through the actual
//! `Project::create`/`Assignment::apply`/`AssignmentRepository::save` path,
//! not raw SQL -- into `hours_verification::AssignmentSnapshot`, and
//! `HourEntry::log` refuses an `Attendee`-mode one while succeeding
//! against a `Contributor`-mode one. Both directions of the event-hours
//! invariant; the Postgres trigger's independent enforcement of the same
//! rule (Prompt 1.2) is already exercised by
//! `kernel::tests::event_hours_trigger_blocks_attendee_mode_hour_entry_via_raw_sql`.

use api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter;
use chrono::NaiveDate;
use hours_verification::{
    AssignmentSnapshotQuery, AssignmentStatus, HourEntry, HourEntryError, HourEntryRepository,
    Hours, ParticipationMode, SqlxHourEntryRepository,
};
use kernel::{ScopedDb, VolunteerId};
use projects_assignments::{
    Assignment, AssignmentRepository, EventSchedule, Project, ProjectRepository, ProjectType,
    SqlxAssignmentRepository, SqlxProjectRepository,
};
use rust_decimal::Decimal;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};

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

/// `current_actor_role()` (and hence the `project_insert`/`assignment_*`
/// RLS policies) resolves via a `select role from volunteer where id =
/// current_actor_id()` -- a bare `VolunteerId::new()` with no row behind
/// it resolves to `NULL`, which fails every `in ('lead', 'admin')`
/// check. Real rows are required, matching
/// projects-assignments/tests/repository.rs's established pattern.
async fn seed_volunteer(owner_pool: &PgPool, role: &str) -> VolunteerId {
    let id: uuid::Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone, role, status) \
         values ('Test', $1, 'UTC', $2, 'approved') returning id",
    )
    .bind(format!("{}@example.org", uuid::Uuid::new_v4()))
    .bind(role)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    kernel::Id::from_uuid(id)
}

#[tokio::test]
async fn adapter_translates_an_attendee_mode_assignment_and_hour_entry_log_refuses_it() {
    let (_container, db, owner_pool) = scoped_db().await;
    let host = seed_volunteer(&owner_pool, "lead").await;
    let attendee = seed_volunteer(&owner_pool, "volunteer").await;

    let project_repo = SqlxProjectRepository;
    let assignment_repo = SqlxAssignmentRepository;
    let adapter = ProjectsAssignmentsSnapshotAdapter;

    let mut project = Project::create(
        "Weekly Meetup".to_string(),
        "".to_string(),
        ProjectType::Event,
        vec![],
        host,
        Some(EventSchedule {
            next_occurrence_at: chrono::Utc::now(),
            recurrence_note: None,
        }),
    )
    .unwrap();

    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    project_repo.save(&mut tx, &mut project).await.unwrap();
    let mut assignment = Assignment::apply(&project, attendee, "Attendee".to_string()).unwrap();
    assert_eq!(
        assignment.participation_mode(),
        projects_assignments::ParticipationMode::Attendee
    );
    assignment_repo.save(&mut tx, &mut assignment).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(attendee.as_uuid()).await.unwrap();
    let snapshot = adapter.snapshot(&mut tx, assignment.id()).await.unwrap().unwrap();
    tx.commit().await.unwrap();

    assert_eq!(snapshot.assignment_id, assignment.id());
    assert_eq!(snapshot.volunteer_id, attendee);
    assert_eq!(snapshot.project_id, project.id());
    assert_eq!(snapshot.participation_mode, ParticipationMode::Attendee);
    // Not yet approved (Assignment::apply leaves it Applied), which
    // HourEntry::log would refuse independently of participation_mode --
    // this test's DB-integration purpose is the mode translation, so the
    // assignment is separately confirmed Applied here and the
    // eligibility check below still exercises the participation_mode
    // rejection path first (checked before the status check in
    // `HourEntry::log`).
    assert_eq!(snapshot.status, AssignmentStatus::Applied);

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
async fn adapter_translates_a_contributor_mode_assignment_and_hour_entry_log_succeeds_and_round_trips() {
    let (_container, db, owner_pool) = scoped_db().await;
    let host = seed_volunteer(&owner_pool, "lead").await;

    let project_repo = SqlxProjectRepository;
    let assignment_repo = SqlxAssignmentRepository;
    let adapter = ProjectsAssignmentsSnapshotAdapter;

    let mut project = Project::create(
        "Weekly Meetup".to_string(),
        "".to_string(),
        ProjectType::Event,
        vec![],
        host,
        Some(EventSchedule {
            next_occurrence_at: chrono::Utc::now(),
            recurrence_note: None,
        }),
    )
    .unwrap();

    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    project_repo.save(&mut tx, &mut project).await.unwrap();
    // The event's own host: Contributor-mode per projects-assignments.md's
    // participation_mode table.
    let mut assignment = Assignment::apply(&project, host, "Host".to_string()).unwrap();
    assert_eq!(
        assignment.participation_mode(),
        projects_assignments::ParticipationMode::Contributor
    );
    assignment.approve(host, true).unwrap();
    assignment_repo.save(&mut tx, &mut assignment).await.unwrap();

    let snapshot = adapter.snapshot(&mut tx, assignment.id()).await.unwrap().unwrap();
    assert_eq!(snapshot.participation_mode, ParticipationMode::Contributor);
    assert_eq!(snapshot.status, AssignmentStatus::Approved);

    let mut entry = HourEntry::log(
        &snapshot,
        NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
        Hours::new(Decimal::from(3)).unwrap(),
        "Led setup and teardown".to_string(),
    )
    .unwrap();

    let hour_repo = SqlxHourEntryRepository;
    let events = hour_repo.save(&mut tx, &mut entry).await.unwrap();
    tx.commit().await.unwrap();

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type(), "hours_logged");

    let mut read_tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    let persisted = hour_repo.find_by_id(&mut read_tx, entry.id()).await.unwrap().unwrap();
    read_tx.commit().await.unwrap();

    assert_eq!(persisted.hours(), entry.hours());
    assert_eq!(persisted.status(), entry.status());
    assert_eq!(persisted.description(), "Led setup and teardown");
}
