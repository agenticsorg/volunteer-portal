//! Prompt 3.1 exit criteria: unit tests for all five `Project` invariants
//! (in `crates/projects-assignments/src/project.rs`); integration test
//! here proving `LeadMembershipQuery` correctly reflects `project_lead`
//! membership including the co-lead case.

use kernel::{Id, VolunteerId};
use projects_assignments::{
    LeadMembershipQuery, LeadRole, Project, ProjectRepository, ProjectType, SqlxProjectRepository,
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
async fn lead_membership_query_reflects_co_lead_membership() {
    let (_container, db, owner_pool) = scoped_db().await;

    let lead_a = seed_volunteer(&owner_pool, "lead").await;
    let lead_b = seed_volunteer(&owner_pool, "lead").await;
    let non_lead = seed_volunteer(&owner_pool, "volunteer").await;

    let mut project =
        Project::create("Website Revamp".into(), "".into(), ProjectType::Project, vec![], lead_a, None)
            .unwrap();
    project.add_lead(lead_b, LeadRole::CoLead, lead_a).unwrap();

    let repo = SqlxProjectRepository;
    let mut tx = db.begin_scoped(lead_a.as_uuid()).await.unwrap();
    repo.save(&mut tx, &mut project).await.unwrap();
    tx.commit().await.unwrap();

    let project_id = project.id();

    // Both leads pass.
    let mut tx = db.begin_scoped(lead_a.as_uuid()).await.unwrap();
    assert!(repo.is_lead_of_project(&mut tx, lead_a, project_id).await.unwrap());
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(lead_b.as_uuid()).await.unwrap();
    assert!(repo.is_lead_of_project(&mut tx, lead_b, project_id).await.unwrap());
    tx.commit().await.unwrap();

    // A non-lead fails.
    let mut tx = db.begin_scoped(non_lead.as_uuid()).await.unwrap();
    assert!(!repo
        .is_lead_of_project(&mut tx, non_lead, project_id)
        .await
        .unwrap());
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn save_and_find_by_id_round_trips_a_project_with_two_leads() {
    let (_container, db, owner_pool) = scoped_db().await;

    let lead_a = seed_volunteer(&owner_pool, "lead").await;
    let lead_b = seed_volunteer(&owner_pool, "lead").await;

    let mut project = Project::create(
        "Website Revamp".into(),
        "Rebuild the site".into(),
        ProjectType::Project,
        vec![kernel::Skill::new("React").unwrap()],
        lead_a,
        None,
    )
    .unwrap();
    project.add_lead(lead_b, LeadRole::CoLead, lead_a).unwrap();

    let repo = SqlxProjectRepository;
    let mut tx = db.begin_scoped(lead_a.as_uuid()).await.unwrap();
    let events = repo.save(&mut tx, &mut project).await.unwrap();
    assert_eq!(events.len(), 2); // ProjectCreated + ProjectLeadAdded
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(lead_a.as_uuid()).await.unwrap();
    let loaded = repo.find_by_id(&mut tx, project.id()).await.unwrap().unwrap();
    tx.commit().await.unwrap();

    assert_eq!(loaded.name(), "Website Revamp");
    assert_eq!(loaded.leads().len(), 2);
    assert!(loaded.is_lead(lead_a));
    assert!(loaded.is_lead(lead_b));
    assert_eq!(loaded.needed_skills().len(), 1);
}
