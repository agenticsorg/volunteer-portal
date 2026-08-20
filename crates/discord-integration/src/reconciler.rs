use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use kernel::{RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::discord_client::{ActualMemberRoles, DiscordApiError, DiscordRoleReadWrite, RoleDelta};
use crate::ids::DiscordRoleId;
use crate::ids::DiscordUserId;
use crate::mapping::DiscordRoleMapping;
use crate::queries::{ActiveProjectMembershipQuery, ApprovedVolunteersQuery};
use crate::role::{DesiredRoleSet, VolunteerFacingRole};

/// A `DesiredRoleSet` with its `VolunteerFacingRole`s already resolved to
/// concrete `DiscordRoleId`s via `DiscordRoleMapping` -- the mapping step
/// is async and fallible per-role (an unmapped `ProjectMember` role is
/// skipped and logged, not a whole-run failure), so it happens once,
/// before `diff`, which is then a genuinely pure function.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedDesiredRoleSet {
    discord_id: DiscordUserId,
    role_ids: HashSet<DiscordRoleId>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReconcileError {
    #[error(transparent)]
    Repo(#[from] RepoError),
    #[error(transparent)]
    Discord(#[from] DiscordApiError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    pub run_id: Uuid,
    /// Number of individual role changes (grants + revokes) the diff
    /// found necessary.
    pub desynced_count: usize,
    /// Number of those role changes that were successfully applied.
    pub corrected_count: usize,
    /// Number of those role changes that failed (rate limit, transient
    /// 5xx, revoked permission) -- retried automatically on the next
    /// scheduled tick, since reconcile is idempotent (discord-integration.md's
    /// "Failure handling").
    pub failed_count: usize,
    pub ran_at: DateTime<Utc>,
    /// Human-readable log entries for `ProjectMember` roles with no
    /// configured `DiscordRoleMapping` entry -- skipped, not a run
    /// failure (discord-integration.md's `DiscordRoleMapping::resolve`
    /// doc comment).
    pub unmapped_roles: Vec<String>,
}

pub struct RoleReconciler<A, P, M, C> {
    approved_volunteers: A,
    active_memberships: P,
    role_mapping: M,
    discord_client: C,
}

impl<A, P, M, C> RoleReconciler<A, P, M, C>
where
    A: ApprovedVolunteersQuery,
    P: ActiveProjectMembershipQuery,
    M: DiscordRoleMapping,
    C: DiscordRoleReadWrite,
{
    pub fn new(approved_volunteers: A, active_memberships: P, role_mapping: M, discord_client: C) -> Self {
        Self {
            approved_volunteers,
            active_memberships,
            role_mapping,
            discord_client,
        }
    }

    pub async fn reconcile(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<ReconcileReport, ReconcileError> {
        let desired = self.compute_desired_state(tx).await?;
        let (resolved, unmapped_roles) = self.resolve_role_ids(desired).await;

        // Every role ID this system manages, across every member in this
        // run -- narrows the live `actual` read down to roles this
        // reconciler is allowed to touch, so a human-assigned role it
        // doesn't manage is never a revocation candidate.
        let managed_role_ids: HashSet<DiscordRoleId> =
            resolved.iter().flat_map(|r| r.role_ids.iter().cloned()).collect();

        // Live REST read -- never a cache, per discord-integration.md's
        // idempotency/self-healing guarantee.
        let actual = self.discord_client.fetch_current_roles().await?;
        let actual_managed: Vec<ActualMemberRoles> = actual
            .into_iter()
            .map(|a| ActualMemberRoles {
                discord_id: a.discord_id,
                role_ids: a
                    .role_ids
                    .into_iter()
                    .filter(|id| managed_role_ids.contains(id))
                    .collect(),
            })
            .collect();

        let delta = diff(&resolved, &actual_managed);
        let desynced_count = delta.iter().map(|d| d.grant.len() + d.revoke.len()).sum();

        let outcomes = self.discord_client.apply_delta(&delta).await;
        let corrected_count = outcomes.iter().filter(|o| o.is_success()).count();
        let failed_count = outcomes.iter().filter(|o| !o.is_success()).count();

        Ok(ReconcileReport {
            run_id: Uuid::new_v4(),
            desynced_count,
            corrected_count,
            failed_count,
            ran_at: Utc::now(),
            unmapped_roles,
        })
    }

    async fn compute_desired_state(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<DesiredRoleSet>, RepoError> {
        let approved = self.approved_volunteers.approved_with_discord_link(tx).await?;
        let memberships = self.active_memberships.active_contributor_memberships(tx).await?;

        let discord_ids: HashMap<VolunteerId, DiscordUserId> = approved.into_iter().collect();

        let mut roles_by_volunteer: HashMap<VolunteerId, Vec<VolunteerFacingRole>> = HashMap::new();
        for volunteer_id in discord_ids.keys() {
            roles_by_volunteer
                .entry(*volunteer_id)
                .or_default()
                .push(VolunteerFacingRole::BaseVolunteer);
        }
        for (volunteer_id, project_id) in memberships {
            // A project membership only matters for Discord roles if the
            // volunteer is also Approved with a linked discord_id --
            // otherwise there's nothing to grant the role to.
            if let Some(roles) = roles_by_volunteer.get_mut(&volunteer_id) {
                roles.push(VolunteerFacingRole::ProjectMember(project_id));
            }
        }

        Ok(roles_by_volunteer
            .into_iter()
            .filter_map(|(volunteer_id, roles)| {
                discord_ids.get(&volunteer_id).map(|discord_id| DesiredRoleSet {
                    volunteer_id,
                    discord_id: discord_id.clone(),
                    roles,
                })
            })
            .collect())
    }

    async fn resolve_role_ids(
        &self,
        desired: Vec<DesiredRoleSet>,
    ) -> (Vec<ResolvedDesiredRoleSet>, Vec<String>) {
        let mut resolved = Vec::with_capacity(desired.len());
        let mut unmapped_roles = Vec::new();

        for set in desired {
            let mut role_ids = HashSet::new();
            for role in &set.roles {
                match self.role_mapping.resolve(role).await {
                    Ok(id) => {
                        role_ids.insert(id);
                    }
                    Err(err) => {
                        unmapped_roles.push(format!("{} ({:?}): {err}", set.discord_id, role));
                    }
                }
            }
            resolved.push(ResolvedDesiredRoleSet {
                discord_id: set.discord_id,
                role_ids,
            });
        }

        (resolved, unmapped_roles)
    }
}

/// Pure diff: no I/O, no async -- straightforward to unit test
/// exhaustively (discord-integration.md's "step 3, pure function").
fn diff(desired: &[ResolvedDesiredRoleSet], actual: &[ActualMemberRoles]) -> Vec<RoleDelta> {
    let actual_by_id: HashMap<&DiscordUserId, HashSet<&DiscordRoleId>> = actual
        .iter()
        .map(|a| (&a.discord_id, a.role_ids.iter().collect()))
        .collect();

    desired
        .iter()
        .filter_map(|d| {
            let empty = HashSet::new();
            let actual_roles = actual_by_id.get(&d.discord_id).unwrap_or(&empty);
            let desired_roles: HashSet<&DiscordRoleId> = d.role_ids.iter().collect();

            let grant: Vec<DiscordRoleId> = desired_roles
                .difference(actual_roles)
                .map(|r| (*r).clone())
                .collect();
            let revoke: Vec<DiscordRoleId> = actual_roles
                .difference(&desired_roles)
                .map(|r| (*r).clone())
                .collect();

            if grant.is_empty() && revoke.is_empty() {
                None
            } else {
                Some(RoleDelta {
                    discord_id: d.discord_id.clone(),
                    grant,
                    revoke,
                })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> DiscordUserId {
        DiscordUserId(id.to_string())
    }
    fn role(id: &str) -> DiscordRoleId {
        DiscordRoleId(id.to_string())
    }
    fn resolved(discord_id: &str, role_ids: &[&str]) -> ResolvedDesiredRoleSet {
        ResolvedDesiredRoleSet {
            discord_id: user(discord_id),
            role_ids: role_ids.iter().map(|r| role(r)).collect(),
        }
    }
    fn actual(discord_id: &str, role_ids: &[&str]) -> ActualMemberRoles {
        ActualMemberRoles {
            discord_id: user(discord_id),
            role_ids: role_ids.iter().map(|r| role(r)).collect(),
        }
    }

    #[test]
    fn no_delta_when_desired_matches_actual_exactly() {
        let desired = vec![resolved("u1", &["base"])];
        let actual = vec![actual("u1", &["base"])];
        assert!(diff(&desired, &actual).is_empty());
    }

    #[test]
    fn grants_a_role_the_member_is_missing() {
        let desired = vec![resolved("u1", &["base"])];
        let actual = vec![actual("u1", &[])];
        let delta = diff(&desired, &actual);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].grant, vec![role("base")]);
        assert!(delta[0].revoke.is_empty());
    }

    #[test]
    fn revokes_a_role_the_member_should_no_longer_have() {
        // Simulates a manually-desynced role: the member has "project-x"
        // but it's no longer in the desired (managed) set -- proves the
        // self-healing exit criterion's core mechanism, that a manual
        // desync is corrected purely by diffing against live state, with
        // no "did we already grant this" cache consulted.
        let desired = vec![resolved("u1", &["base"])];
        let actual = vec![actual("u1", &["base", "project-x"])];
        let delta = diff(&desired, &actual);
        assert_eq!(delta.len(), 1);
        assert!(delta[0].grant.is_empty());
        assert_eq!(delta[0].revoke, vec![role("project-x")]);
    }

    #[test]
    fn grants_and_revokes_together_for_the_same_member() {
        let desired = vec![resolved("u1", &["base", "project-y"])];
        let actual = vec![actual("u1", &["base", "project-x"])];
        let delta = diff(&desired, &actual);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].grant, vec![role("project-y")]);
        assert_eq!(delta[0].revoke, vec![role("project-x")]);
    }

    #[test]
    fn member_with_no_actual_row_is_treated_as_having_no_roles() {
        let desired = vec![resolved("u1", &["base"])];
        let actual: Vec<ActualMemberRoles> = vec![];
        let delta = diff(&desired, &actual);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].grant, vec![role("base")]);
    }

    #[test]
    fn re_running_with_no_state_change_produces_no_delta_idempotent() {
        let desired = vec![resolved("u1", &["base", "project-x"])];
        let actual = vec![actual("u1", &["base", "project-x"])];
        assert!(diff(&desired, &actual).is_empty());
        // Running it again against the same inputs is still empty --
        // diff has no internal state to drift.
        assert!(diff(&desired, &actual).is_empty());
    }

    #[test]
    fn unrelated_members_do_not_affect_each_others_delta() {
        let desired = vec![resolved("u1", &["base"]), resolved("u2", &["base", "project-x"])];
        let actual = vec![actual("u1", &["base"]), actual("u2", &["base"])];
        let delta = diff(&desired, &actual);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].discord_id, user("u2"));
    }
}
