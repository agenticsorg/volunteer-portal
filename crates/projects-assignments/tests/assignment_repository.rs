//! Prompt 3.2 exit criteria:
//! - A test proves a non-lead cannot approve/remove an assignment for a
//!   project they don't lead, even via a crafted request bypassing the
//!   UI -- exercised here as a raw SQL UPDATE attempt scoped as the
//!   non-lead through the non-owner `app_user` role, i.e. exactly the
//!   RLS backstop ADR-0004 describes as defense-in-depth behind the
//!   `LeadOf` extractor (which doesn't exist as an HTTP endpoint until
//!   Prompt 3.3, so RLS is what "server-side" enforcement means at this
//!   point in the build).
//! - `participation_mode` is computed correctly for all three cases and
//!   round-trips correctly through the repository.

use kernel::{Id, VolunteerId};
use projects_assignments::{
    Assignment, AssignmentRepository, ParticipationMode, Project, ProjectRepository,
    ProjectType, SqlxAssignmentRepository, SqlxProjectRepository,
};
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

async fn scoped_db() -> (
    testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    kernel::ScopedDb,
    PgPool,
) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();

    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    (container, kernel::ScopedDb::new(app_pool), owner_pool)
}

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
    Id::from_uuid(id)
}

#[tokio::test]
async fn non_lead_cannot_approve_an_assignment_even_via_raw_sql() {
    let (_container, db, owner_pool) = scoped_db().await;

    let lead = seed_volunteer(&owner_pool, "lead").await;
    let applicant = seed_volunteer(&owner_pool, "volunteer").await;
    let stranger = seed_volunteer(&owner_pool, "volunteer").await;

    let mut project =
        Project::create("Website Revamp".into(), "".into(), ProjectType::Project, vec![], lead, None)
            .unwrap();
    let project_repo = SqlxProjectRepository;
    let mut tx = db.begin_scoped(lead.as_uuid()).await.unwrap();
    project_repo.save(&mut tx, &mut project).await.unwrap();
    tx.commit().await.unwrap();

    let mut assignment = Assignment::apply(&project, applicant, "Contributor".into()).unwrap();
    let assignment_repo = SqlxAssignmentRepository;
    let mut tx = db.begin_scoped(applicant.as_uuid()).await.unwrap();
    assignment_repo.save(&mut tx, &mut assignment).await.unwrap();
    tx.commit().await.unwrap();

    // A stranger (not a lead of this project, not the applicant) attempts
    // to approve the assignment via a raw SQL UPDATE -- simulating a
    // crafted request that bypasses whatever the UI/API layer would
    // normally check. RLS's assignment_update policy must refuse this
    // regardless.
    let mut tx = db.begin_scoped(stranger.as_uuid()).await.unwrap();
    let result = sqlx::query(
        "update assignment set status = 'approved', decided_by = $1, decided_at = now() where id = $2",
    )
    .bind(stranger.as_uuid())
    .bind(assignment.id().as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        result.rows_affected(),
        0,
        "a non-lead's UPDATE must affect zero rows under RLS, not error and not succeed"
    );

    // Confirm it's genuinely untouched.
    let mut tx = db.begin_scoped(lead.as_uuid()).await.unwrap();
    let reloaded = assignment_repo
        .find_by_id(&mut tx, assignment.id())
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(reloaded.status(), projects_assignments::AssignmentStatus::Applied);

    // The actual lead succeeds via the same raw-SQL path (proving the
    // block above was specifically about lead membership, not a broken
    // policy that blocks everyone).
    let mut tx = db.begin_scoped(lead.as_uuid()).await.unwrap();
    let result = sqlx::query(
        "update assignment set status = 'approved', decided_by = $1, decided_at = now() where id = $2",
    )
    .bind(lead.as_uuid())
    .bind(assignment.id().as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(result.rows_affected(), 1);
}

#[tokio::test]
async fn participation_mode_round_trips_correctly_for_all_three_cases() {
    let (_container, db, owner_pool) = scoped_db().await;

    let host = seed_volunteer(&owner_pool, "lead").await;
    let contributor_volunteer = seed_volunteer(&owner_pool, "volunteer").await;
    let attendee_volunteer = seed_volunteer(&owner_pool, "volunteer").await;

    // Case 1: project-type -> always Contributor.
    let mut standing_project = Project::create(
        "Website Revamp".into(),
        "".into(),
        ProjectType::Project,
        vec![],
        host,
        None,
    )
    .unwrap();
    let project_repo = SqlxProjectRepository;
    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    project_repo.save(&mut tx, &mut standing_project).await.unwrap();
    tx.commit().await.unwrap();

    let mut project_assignment =
        Assignment::apply(&standing_project, contributor_volunteer, "Contributor".into()).unwrap();
    let assignment_repo = SqlxAssignmentRepository;
    let mut tx = db.begin_scoped(contributor_volunteer.as_uuid()).await.unwrap();
    assignment_repo.save(&mut tx, &mut project_assignment).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    let reloaded = assignment_repo
        .find_by_id(&mut tx, project_assignment.id())
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(reloaded.participation_mode(), ParticipationMode::Contributor);

    // Case 2 & 3: event-type -> lead is Contributor, non-lead is Attendee.
    let mut event = Project::create(
        "Weekly Meetup".into(),
        "".into(),
        ProjectType::Event,
        vec![],
        host,
        Some(projects_assignments::EventSchedule {
            next_occurrence_at: chrono::Utc::now(),
            recurrence_note: None,
        }),
    )
    .unwrap();
    // `host` is already the initial lead from Project::create.
    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    project_repo.save(&mut tx, &mut event).await.unwrap();
    tx.commit().await.unwrap();

    let mut host_assignment = Assignment::apply(&event, host, "Host".into()).unwrap();
    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    assignment_repo.save(&mut tx, &mut host_assignment).await.unwrap();
    tx.commit().await.unwrap();

    let mut attendee_assignment =
        Assignment::apply(&event, attendee_volunteer, "Attendee".into()).unwrap();
    let mut tx = db.begin_scoped(attendee_volunteer.as_uuid()).await.unwrap();
    assignment_repo.save(&mut tx, &mut attendee_assignment).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(host.as_uuid()).await.unwrap();
    let reloaded_host = assignment_repo
        .find_by_id(&mut tx, host_assignment.id())
        .await
        .unwrap()
        .unwrap();
    let reloaded_attendee = assignment_repo
        .find_by_id(&mut tx, attendee_assignment.id())
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(reloaded_host.participation_mode(), ParticipationMode::Contributor);
    assert_eq!(reloaded_attendee.participation_mode(), ParticipationMode::Attendee);
}
