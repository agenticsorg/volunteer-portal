//! Prompt 8.2 (build-roadmap.md's Phase 8 blocking gate): a verification
//! suite, not new feature work. compliance-audit.md's "Which aggregates
//! across the system emit audit-worthy events" table is the checklist;
//! this file exercises every row marked `Yes` and asserts the exact
//! `action`/`entity_type` `audit_log` row it must produce. Deliberately
//! drives each aggregate's domain method + repository `save()` +
//! `kernel::record_audit_events` directly (the same shape
//! `audit_wiring.rs`'s `test_approve` already established for one case)
//! rather than through HTTP -- this suite's whole job is proving the
//! framework-level audit wiring itself, not re-testing HTTP routing/
//! authorization that other test files already cover.
//!
//! Two rows are deliberately absent from this checklist:
//! `DiscordRoleReconciled` and `NotificationSent`/`NotificationFailed`
//! are explicitly marked "No" in compliance-audit.md's table (neither
//! implements `AuditableEvent`) -- there is nothing to assert for them
//! here. "Discord link completed" (named in Prompt 8.2's own checklist
//! text) is *not* a separate row: compliance-audit.md's 2026-08-20
//! amendment records that every linking mutation, Discord-initiated or
//! not, converges on `OAuthAccountLinked` -- covered below by
//! `oauth_account_linked_is_updated_on_volunteer`.

use chrono::Utc;
use hours_verification::{HourEntry, HourEntryRepository, Hours, SqlxHourEntryRepository};
use identity_access::{
    Availability, OAuthProvider, Role, SqlxVolunteerRepository, Volunteer, VolunteerRepository,
};
use kernel::{record_audit_events, ScopedDb};
use projects_assignments::{
    Assignment, AssignmentRepository, LeadRole, Project, ProjectRepository, ProjectType,
    SqlxAssignmentRepository, SqlxProjectRepository,
};
use rust_decimal::Decimal;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

async fn setup() -> (testcontainers_modules::testcontainers::ContainerAsync<Postgres>, PgPool, PgPool) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();
    (container, owner_pool, app_pool)
}

/// Asserts the single most-recently-written `audit_log` row (by
/// `created_at`, matching this table's insert-order-is-append-only
/// design) has exactly the given `action`/`entity_type`/`entity_id`.
/// Called once per event in this suite, immediately after that event's
/// `record_audit_events` call, so "most recent" is unambiguous.
async fn assert_latest_audit_row(
    owner_pool: &PgPool,
    expected_action: &str,
    expected_entity_type: &str,
    expected_entity_id: uuid::Uuid,
) {
    let (action, entity_type, entity_id): (String, String, uuid::Uuid) =
        sqlx::query_as("select action, entity_type, entity_id from audit_log order by created_at desc limit 1")
            .fetch_one(owner_pool)
            .await
            .unwrap();
    assert_eq!(action, expected_action, "action mismatch for entity_type {expected_entity_type}");
    assert_eq!(entity_type, expected_entity_type);
    assert_eq!(entity_id, expected_entity_id);
}

async fn audit_log_count(owner_pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from audit_log").fetch_one(owner_pool).await.unwrap()
}

#[tokio::test]
async fn every_auditable_event_produces_the_documented_audit_log_row() {
    let (_container, owner_pool, app_pool) = setup().await;
    let db = ScopedDb::new(app_pool);

    // --- Identity & Access -------------------------------------------

    // 1. VolunteerOnboarded -- Created / volunteer.
    let mut admin = Volunteer::signup(
        "Admin Actor".to_string(),
        "audit-admin@example.org".to_string(),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        OAuthProvider::Discord,
        "audit-admin-discord".to_string(),
        "audit-admin@example.org".to_string(),
        true,
    )
    .unwrap();
    let admin_id = admin.id();
    let volunteer_repo = SqlxVolunteerRepository;
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let events = volunteer_repo.save(&mut tx, &mut admin).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "created", "volunteer", admin_id.as_uuid()).await;

    // Promote admin to Admin role directly (bypassing the RoleChanged
    // assertion below, which needs a *fresh* role change of its own) so
    // later admin-gated domain calls in this test have a real admin
    // actor, matching every other test file's `promote_to_admin` shape.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut a = volunteer_repo.find_by_id(&mut tx, admin_id).await.unwrap().unwrap();
        a.change_role(Role::Admin, admin_id).unwrap();
        volunteer_repo.save(&mut tx, &mut a).await.unwrap();
        tx.commit().await.unwrap();
    }

    let mut target = Volunteer::signup(
        "Target Volunteer".to_string(),
        "audit-target@example.org".to_string(),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        OAuthProvider::Discord,
        "audit-target-discord".to_string(),
        "audit-target@example.org".to_string(),
        true,
    )
    .unwrap();
    let target_id = target.id();
    {
        let mut tx = db.begin_scoped(target_id.as_uuid()).await.unwrap();
        let events = volunteer_repo.save(&mut tx, &mut target).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    // Same event type as step 1 above, fired for this scenario's second
    // volunteer -- asserted again here (a second, independent VolunteerOnboarded
    // row) since this scenario naturally needs two distinct volunteers
    // (admin actor, target subject) and both signups are real, audited
    // mutations.
    assert_latest_audit_row(&owner_pool, "created", "volunteer", target_id.as_uuid()).await;

    // 2. VolunteerApproved -- Updated / volunteer.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut t = volunteer_repo.find_by_id(&mut tx, target_id).await.unwrap().unwrap();
        t.record_agreements(identity_access::Agreements {
            code_of_conduct_accepted_at: Some(Utc::now()),
            ip_agreement_accepted_at: Some(Utc::now()),
            age_attestation_confirmed_at: Some(Utc::now()),
        });
        t.approve(admin_id).unwrap();
        let events = volunteer_repo.save(&mut tx, &mut t).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "updated", "volunteer", target_id.as_uuid()).await;

    // 3. RoleChanged -- role_changed / volunteer.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut t = volunteer_repo.find_by_id(&mut tx, target_id).await.unwrap().unwrap();
        t.change_role(Role::Lead, admin_id).unwrap();
        let events = volunteer_repo.save(&mut tx, &mut t).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "role_changed", "volunteer", target_id.as_uuid()).await;

    // 4. OAuthAccountLinked -- Updated / volunteer (compliance-audit.md's
    // amendment: this is what "Discord link completed" converges on,
    // Discord-initiated or not).
    {
        let mut tx = db.begin_scoped(target_id.as_uuid()).await.unwrap();
        let mut t = volunteer_repo.find_by_id(&mut tx, target_id).await.unwrap().unwrap();
        t.link_additional_provider(
            OAuthProvider::Google,
            "audit-target-google".to_string(),
            "audit-target@example.org".to_string(),
            true,
            target_id,
        )
        .unwrap();
        let events = volunteer_repo.save(&mut tx, &mut t).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "updated", "volunteer", target_id.as_uuid()).await;

    // --- Projects & Assignments ---------------------------------------

    // 5. ProjectCreated -- Created / project.
    let mut project = Project::create(
        "Audit Coverage Project".to_string(),
        "".to_string(),
        ProjectType::Project,
        vec![],
        admin_id,
        None,
    )
    .unwrap();
    let project_id = project.id();
    let project_repo = SqlxProjectRepository;
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let events = project_repo.save(&mut tx, &mut project).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "created", "project", project_id.as_uuid()).await;

    // 6. ProjectLeadAdded -- Updated / project (target becomes a co-lead
    // so the next step, ProjectLeadRemoved, has a second lead to remove
    // without tripping the "cannot remove the last lead" invariant).
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut p = project_repo.find_by_id(&mut tx, project_id).await.unwrap().unwrap();
        p.add_lead(target_id, LeadRole::CoLead, admin_id).unwrap();
        let events = project_repo.save(&mut tx, &mut p).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "updated", "project", project_id.as_uuid()).await;

    // 7. ProjectLeadRemoved -- Updated / project.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut p = project_repo.find_by_id(&mut tx, project_id).await.unwrap().unwrap();
        p.remove_lead(target_id, admin_id).unwrap();
        let events = project_repo.save(&mut tx, &mut p).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "updated", "project", project_id.as_uuid()).await;

    // 8. AssignmentApplied -- Created / assignment (before ProjectClosed
    // below, since Assignment::apply requires an Open project).
    let project_snapshot = {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let p = project_repo.find_by_id(&mut tx, project_id).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        p
    };
    let mut assignment = Assignment::apply(&project_snapshot, target_id, "Volunteer".to_string()).unwrap();
    let assignment_id = assignment.id();
    let assignment_repo = SqlxAssignmentRepository;
    {
        let mut tx = db.begin_scoped(target_id.as_uuid()).await.unwrap();
        let events = assignment_repo.save(&mut tx, &mut assignment).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "created", "assignment", assignment_id.as_uuid()).await;

    // 9. AssignmentApproved -- Updated / assignment.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut a = assignment_repo.find_by_id(&mut tx, assignment_id).await.unwrap().unwrap();
        a.approve(admin_id, true).unwrap();
        let events = assignment_repo.save(&mut tx, &mut a).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "updated", "assignment", assignment_id.as_uuid()).await;

    // --- Hours & Verification (against the now-approved assignment) --

    let assignment_snapshot = {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let a = assignment_repo.find_by_id(&mut tx, assignment_id).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        a
    };
    let hour_entry_repo = SqlxHourEntryRepository;

    // 10. HoursLogged -- Created / hour_entry.
    let snapshot_for_hours = hours_verification::AssignmentSnapshot {
        assignment_id: assignment_snapshot.id(),
        volunteer_id: assignment_snapshot.volunteer_id(),
        project_id: assignment_snapshot.project_id(),
        participation_mode: hours_verification::ParticipationMode::Contributor,
        status: hours_verification::AssignmentStatus::Approved,
    };
    let mut hour_entry = HourEntry::log(
        &snapshot_for_hours,
        chrono::NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
        Hours::new(Decimal::from(3)).unwrap(),
        "Audit coverage entry".to_string(),
    )
    .unwrap();
    let hour_entry_id = hour_entry.id();
    {
        let mut tx = db.begin_scoped(target_id.as_uuid()).await.unwrap();
        let events = hour_entry_repo.save(&mut tx, &mut hour_entry).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "created", "hour_entry", hour_entry_id.as_uuid()).await;

    // 11. HoursApproved -- hour_approved / hour_entry.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut e = hour_entry_repo.find_by_id(&mut tx, hour_entry_id).await.unwrap().unwrap();
        e.approve(admin_id, true).unwrap();
        let events = hour_entry_repo.save(&mut tx, &mut e).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "hour_approved", "hour_entry", hour_entry_id.as_uuid()).await;

    // 12. HoursAdjusted -- hour_adjusted / hour_entry (on the now-
    // approved entry -- adjust requires Approved status).
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut e = hour_entry_repo.find_by_id(&mut tx, hour_entry_id).await.unwrap().unwrap();
        e.adjust(admin_id, true, Hours::new(Decimal::from(4)).unwrap(), "Audit coverage correction".to_string())
            .unwrap();
        let events = hour_entry_repo.save(&mut tx, &mut e).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "hour_adjusted", "hour_entry", hour_entry_id.as_uuid()).await;

    // 13. HoursRejected -- hour_rejected / hour_entry (a second, still-
    // Pending entry -- the approved one above can't transition again).
    let mut second_entry = HourEntry::log(
        &snapshot_for_hours,
        chrono::NaiveDate::from_ymd_opt(2026, 1, 16).unwrap(),
        Hours::new(Decimal::from(2)).unwrap(),
        "Second audit coverage entry".to_string(),
    )
    .unwrap();
    let second_entry_id = second_entry.id();
    {
        let mut tx = db.begin_scoped(target_id.as_uuid()).await.unwrap();
        hour_entry_repo.save(&mut tx, &mut second_entry).await.unwrap();
        tx.commit().await.unwrap();
    }
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut e = hour_entry_repo.find_by_id(&mut tx, second_entry_id).await.unwrap().unwrap();
        e.reject(admin_id, true, Some("Audit coverage rejection".to_string())).unwrap();
        let events = hour_entry_repo.save(&mut tx, &mut e).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "hour_rejected", "hour_entry", second_entry_id.as_uuid()).await;

    // --- Back to Projects & Assignments for the two remaining rows ---

    // 14. AssignmentRemoved -- Deleted / assignment.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut a = assignment_repo.find_by_id(&mut tx, assignment_id).await.unwrap().unwrap();
        a.remove(admin_id, true, Some("Audit coverage removal".to_string())).unwrap();
        let events = assignment_repo.save(&mut tx, &mut a).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "deleted", "assignment", assignment_id.as_uuid()).await;

    // 15. ProjectClosed -- Updated / project.
    {
        let mut tx = db.begin_scoped(admin_id.as_uuid()).await.unwrap();
        let mut p = project_repo.find_by_id(&mut tx, project_id).await.unwrap().unwrap();
        p.close(admin_id);
        let events = project_repo.save(&mut tx, &mut p).await.unwrap();
        record_audit_events(&mut tx, &events).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_latest_audit_row(&owner_pool, "updated", "project", project_id.as_uuid()).await;

    // Every step above asserted its own row landed as the newest one;
    // this closes the loop by confirming the *count* also matches --
    // no step silently wrote zero or more than one row (a repeated
    // action, or a step whose event didn't implement AuditableEvent as
    // expected, would show up here as a count short of 16). 16, not 15:
    // the 15 compliance-audit.md "Yes" events, plus a second, independent
    // VolunteerOnboarded row for this scenario's second volunteer
    // (asserted above).
    assert_eq!(
        audit_log_count(&owner_pool).await,
        16,
        "exactly 16 audit_log rows must exist -- one per compliance-audit.md 'Yes' event exercised above, plus the second volunteer's own VolunteerOnboarded row"
    );
}
