//! Prompt 5.1 exit criterion (build-roadmap.md: "reconcile job is
//! idempotent and self-heals"): manually desync a role, run the
//! reconcile job, confirm the correction -- proven here against a fake,
//! stateful `DiscordRoleReadWrite` standing in for a live Discord guild
//! (no live Discord bot token/dev guild credentials are available in
//! this environment; the real infra layer, `TwilightDiscordClient`
//! against `twilight-http`, is implemented and ready in
//! `discord-integration::infra`, but exercising it against an actual
//! Discord API is blocked on credentials).
//!
//! This test drives the reconciler through the real `apps/api` adapter
//! (`ProjectsAssignmentsActiveMembershipAdapter`) and the real
//! `identity-access`-backed `ApprovedVolunteersQuery`, so the only fake
//! is the Discord side itself -- everything upstream of that boundary
//! (the desired-state computation) is exercised for real.
//!
//! `FakeDiscordClient` shares its state via `Arc<Mutex<...>>`, so the
//! test keeps a handle to the exact same mutable state the reconciler
//! reads from and writes to -- the test mutates the shared state
//! directly between two `reconcile()` calls (standing in for a
//! moderator clicking "remove role" in the Discord UI), with nothing in
//! `RoleReconciler` itself remembering what the previous run did.
//! `RoleReconciler` holds no state of its own beyond its four injected
//! ports, so there is nothing it *could* cache -- each call's
//! `desynced_count`/`corrected_count` can only be correct if it re-read
//! live state from the fake every time.
//!
//! Every `reconcile()` call here is scoped via `db.begin_system_scoped()`
//! -- the same actor-less transaction `apps/api/src/bin/reconcile_discord_roles.rs`
//! actually uses in production, not `begin_scoped(volunteer_id)`. An
//! earlier version of this test used the latter, which happened to make
//! `volunteer_select`'s RLS policy pass (the seeded volunteer could see
//! their own row) without exercising the real production scoping at all
//! -- masking a real bug where `volunteer_select`/`assignment_select`
//! had no `current_actor_id() is null` fallback, so the real
//! `begin_system_scoped()` job silently read zero rows and did nothing
//! on every actual run. Fixed by migration 20260819000011; this test now
//! actually proves the fix by using the real scoping.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use api::active_membership_adapter::ProjectsAssignmentsActiveMembershipAdapter;
use async_trait::async_trait;
use discord_integration::{
    ActualMemberRoles, DiscordApiError, DiscordRoleId, DiscordRoleMapping, DiscordRoleReadWrite,
    DiscordUserId, IdentityAccessApprovedVolunteersQuery, MappingError, RoleChangeAction,
    RoleChangeOutcome, RoleDelta, RoleReconciler, VolunteerFacingRole,
};
use identity_access::SqlxVolunteerSummaryQuery;
use kernel::ScopedDb;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

struct FakeRoleMapping;

#[async_trait]
impl DiscordRoleMapping for FakeRoleMapping {
    async fn resolve(&self, role: &VolunteerFacingRole) -> Result<DiscordRoleId, MappingError> {
        match role {
            VolunteerFacingRole::BaseVolunteer => Ok(DiscordRoleId("base".to_string())),
            VolunteerFacingRole::ProjectMember(project_id) => {
                Ok(DiscordRoleId(format!("project-{project_id}")))
            }
        }
    }
}

#[derive(Clone)]
struct FakeDiscordClient {
    state: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

impl FakeDiscordClient {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Directly overwrites a member's actual roles -- standing in for a
    /// human manually changing roles in the Discord UI between
    /// reconcile runs.
    fn set_actual(&self, discord_id: &str, role_ids: &[&str]) {
        self.state
            .lock()
            .unwrap()
            .insert(discord_id.to_string(), role_ids.iter().map(|s| s.to_string()).collect());
    }
}

#[async_trait]
impl DiscordRoleReadWrite for FakeDiscordClient {
    async fn fetch_current_roles(&self) -> Result<Vec<ActualMemberRoles>, DiscordApiError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .iter()
            .map(|(discord_id, role_ids)| ActualMemberRoles {
                discord_id: DiscordUserId(discord_id.clone()),
                role_ids: role_ids.iter().map(|r| DiscordRoleId(r.clone())).collect(),
            })
            .collect())
    }

    async fn apply_delta(&self, deltas: &[RoleDelta]) -> Vec<RoleChangeOutcome> {
        let mut state = self.state.lock().unwrap();
        let mut outcomes = Vec::new();
        for delta in deltas {
            let roles = state.entry(delta.discord_id.0.clone()).or_default();
            for role_id in &delta.grant {
                if !roles.contains(&role_id.0) {
                    roles.push(role_id.0.clone());
                }
                outcomes.push(RoleChangeOutcome {
                    discord_id: delta.discord_id.clone(),
                    role_id: role_id.clone(),
                    action: RoleChangeAction::Grant,
                    error: None,
                });
            }
            for role_id in &delta.revoke {
                roles.retain(|r| r != &role_id.0);
                outcomes.push(RoleChangeOutcome {
                    discord_id: delta.discord_id.clone(),
                    role_id: role_id.clone(),
                    action: RoleChangeAction::Revoke,
                    error: None,
                });
            }
        }
        outcomes
    }
}

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

#[tokio::test]
async fn reconcile_corrects_a_manually_desynced_role_with_no_cache_and_self_heals_again() {
    let (_container, db, owner_pool) = scoped_db().await;

    let volunteer_id: Uuid = sqlx::query_scalar(
        "insert into volunteer (name, email, timezone, role, status, discord_id) \
         values ('Approved Volunteer', 'volunteer@example.org', 'UTC', 'volunteer', 'approved', '1000') \
         returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let project_id: Uuid = sqlx::query_scalar(
        "insert into project (name, type, status) values ('Trail Cleanup', 'project', 'open') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    sqlx::query(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status) \
         values ($1, $2, 'Contributor', 'contributor', 'approved')",
    )
    .bind(volunteer_id)
    .bind(project_id)
    .execute(&owner_pool)
    .await
    .unwrap();

    let project_role = format!("project-{project_id}");
    let client = FakeDiscordClient::new();

    let reconciler = RoleReconciler::new(
        IdentityAccessApprovedVolunteersQuery::new(SqlxVolunteerSummaryQuery),
        ProjectsAssignmentsActiveMembershipAdapter,
        FakeRoleMapping,
        client.clone(),
    );

    // Discord starts fully desynced: the member has neither role at all.
    let mut tx = db.begin_system_scoped().await.unwrap();
    let report = reconciler.reconcile(&mut tx).await.unwrap();
    tx.commit().await.unwrap();

    assert_eq!(report.desynced_count, 2, "both base and project roles were missing");
    assert_eq!(report.corrected_count, 2);
    assert_eq!(report.failed_count, 0);

    // Idempotent: re-running immediately, with nothing changed, makes no
    // further corrections. This can only be correct if reconcile()
    // re-read the fake's live state rather than trusting the previous
    // report -- there is no cache anywhere for it to consult instead.
    let mut tx = db.begin_system_scoped().await.unwrap();
    let second = reconciler.reconcile(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(second.desynced_count, 0, "re-running with no state change must find nothing to correct");
    assert_eq!(second.corrected_count, 0);

    // Manually desync: a moderator removes the project role in the
    // Discord UI (simulated by mutating the fake's shared state
    // directly, bypassing apply_delta entirely).
    client.set_actual("1000", &["base"]);

    let mut tx = db.begin_system_scoped().await.unwrap();
    let third = reconciler.reconcile(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(third.desynced_count, 1, "the manually-removed project role must be found as desynced");
    assert_eq!(third.corrected_count, 1);

    let final_roles = client
        .fetch_current_roles()
        .await
        .unwrap()
        .into_iter()
        .find(|m| m.discord_id == DiscordUserId("1000".to_string()))
        .unwrap()
        .role_ids;
    assert!(final_roles.contains(&DiscordRoleId("base".to_string())));
    assert!(final_roles.contains(&DiscordRoleId(project_role.clone())));

    // Self-healing in the other direction: a human grants a role by
    // mistake that this system doesn't manage at all.
    client.set_actual("1000", &["base", project_role.as_str(), "stale-role"]);

    let mut tx = db.begin_system_scoped().await.unwrap();
    let fourth = reconciler.reconcile(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        fourth.desynced_count, 0,
        "'stale-role' is not a managed role, so it is not a revocation candidate"
    );
    assert_eq!(fourth.corrected_count, 0);
}
