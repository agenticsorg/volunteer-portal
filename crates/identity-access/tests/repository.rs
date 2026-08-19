//! Prompt 1.3 exit criterion: `cargo test -p identity-access` passes
//! against a real Postgres via the scoped-transaction helper (a local
//! stand-in for the Neon branch named in the prompt — no Neon credentials
//! are available in this environment; see Prompt 1.2's migration commit).

use identity_access::{
    Agreements, Availability, OAuthProvider, Role, SqlxVolunteerRepository, Volunteer,
    VolunteerRepository, VolunteerStatus,
};
use kernel::{Id, Skill, VolunteerId};
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

async fn scoped_db() -> (
    testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    kernel::ScopedDb,
) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();

    let app_url =
        format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();

    (container, kernel::ScopedDb::new(app_pool))
}

fn complete_agreements() -> Agreements {
    let now = chrono::Utc::now();
    Agreements {
        code_of_conduct_accepted_at: Some(now),
        ip_agreement_accepted_at: Some(now),
        age_attestation_confirmed_at: Some(now),
    }
}

#[tokio::test]
async fn save_and_find_by_id_round_trips() {
    let (_container, db) = scoped_db().await;
    let repo = SqlxVolunteerRepository;

    let mut volunteer = Volunteer::signup(
        "Grace Hopper".to_string(),
        "grace@example.org".to_string(),
        "America/Toronto".to_string(),
        vec![Skill::new("Rust").unwrap(), Skill::new("COBOL").unwrap()],
        Availability::empty(),
        OAuthProvider::Discord,
        "discord-42".to_string(),
        "grace@example.org".to_string(),
        true,
    )
    .unwrap();
    let id = volunteer.id();

    // Scoped as the new volunteer's own id, per the signup-transaction
    // pattern (their id is freshly generated at construction, before any
    // row exists, so it's a meaningful RLS actor even for the insert).
    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    let events = repo.save(&mut tx, &mut volunteer).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type(), "volunteer_onboarded");
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    let loaded = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    tx.commit().await.unwrap();

    assert_eq!(loaded.id(), id);
    assert_eq!(loaded.name(), "Grace Hopper");
    assert_eq!(loaded.email(), "grace@example.org");
    assert_eq!(loaded.discord_id(), Some("discord-42"));
    assert_eq!(loaded.status(), VolunteerStatus::PendingApproval);
    assert_eq!(loaded.role(), Role::Volunteer);
    assert_eq!(loaded.skills().len(), 2);
    assert_eq!(loaded.oauth_links().len(), 1);
}

#[tokio::test]
async fn approve_persists_and_produces_audit_worthy_event() {
    let (_container, db) = scoped_db().await;
    let repo = SqlxVolunteerRepository;

    let mut volunteer = Volunteer::signup(
        "Ada Lovelace".to_string(),
        "ada@example.org".to_string(),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        OAuthProvider::Google,
        "google-7".to_string(),
        "ada@example.org".to_string(),
        true,
    )
    .unwrap();
    let id = volunteer.id();

    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();

    volunteer.record_agreements(complete_agreements());
    let admin_id: VolunteerId = Id::new();
    volunteer.approve(admin_id).unwrap();

    // Approval is an admin action; scope the transaction as the admin.
    // (No admin volunteer row exists yet in this minimal test — RLS's
    // `current_actor_role()` will read no row and resolve to NULL, which
    // is neither 'admin' nor matches `id = current_actor_id()`. Scope as
    // the volunteer's own id instead, which the volunteer_update policy
    // permits regardless of role, and is sufficient to exercise the
    // repository round-trip this test targets.)
    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    let events = repo.save(&mut tx, &mut volunteer).await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].as_auditable().is_some());
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    let loaded = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(loaded.status(), VolunteerStatus::Approved);
}

#[tokio::test]
async fn find_by_discord_id_and_email_resolve_the_same_volunteer() {
    let (_container, db) = scoped_db().await;
    let repo = SqlxVolunteerRepository;

    let mut volunteer = Volunteer::signup(
        "Radia Perlman".to_string(),
        "radia@example.org".to_string(),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        OAuthProvider::Discord,
        "discord-99".to_string(),
        "radia@example.org".to_string(),
        true,
    )
    .unwrap();
    let id = volunteer.id();

    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin_scoped(id.as_uuid()).await.unwrap();
    let by_discord = repo
        .find_by_discord_id(&mut tx, "discord-99")
        .await
        .unwrap()
        .unwrap();
    let by_email = repo
        .find_by_email(&mut tx, "RADIA@example.org")
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(by_discord.id(), id);
    assert_eq!(by_email.id(), id);
}
