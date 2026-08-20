-- Prompt 5.1 architect-review finding: the Discord role-reconcile job
-- runs under kernel::ScopedDb::begin_system_scoped() (no `volunteer` row,
-- `current_actor_id()` resolves NULL), but `volunteer_select` and
-- `assignment_select` had no `current_actor_id() is null` fallback --
-- unlike `discord_link`/`reconcile_run_log`/`discord_role_mapping`
-- (migrations 20260819000009/000010), which correctly included it from
-- the start. Under the old policies, a NULL actor satisfies neither
-- `id = current_actor_id()` (NULL = NULL is NULL, not true) nor
-- `current_actor_role() = 'admin'` (also NULL, since that function's own
-- `select role from volunteer where id = current_actor_id()` resolves no
-- rows for a NULL id). Both of RoleReconciler's queries
-- (ApprovedVolunteersQuery::approved_with_discord_link,
-- ActiveProjectMembershipQuery::active_contributor_memberships) silently
-- returned zero rows for every real reconcile run -- the job completed
-- "successfully" and did nothing, forever, with no error surfaced
-- anywhere. Widened to match the already-correct pattern.
--
-- `project_select` was audited too, per the review's explicit request:
-- it is NOT used by this job (ActiveProjectMembershipQuery reads only
-- `assignment`, never joins `project`), so no change is needed there for
-- this prompt's scope -- noted rather than silently assumed fine.

drop policy volunteer_select on volunteer;

create policy volunteer_select on volunteer
    for select
    using (id = current_actor_id() or current_actor_role() = 'admin' or current_actor_id() is null);

drop policy assignment_select on assignment;

create policy assignment_select on assignment
    for select
    using (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or is_lead_of_project(assignment.project_id)
        or current_actor_id() is null
    );
