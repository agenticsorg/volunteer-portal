-- Prompt 1.2: Row-Level Security, per ADR-0004. Every RLS-protected table
-- references current_setting('app.current_user_id'), set per-transaction
-- by kernel::ScopedDb::begin_scoped via `SET LOCAL` semantics
-- (set_config(..., true)). RLS here is the second, independent barrier
-- behind the application-layer checks in Axum extractors (ADR-0002) — a
-- handler that forgets an authorization check still cannot read or write
-- rows outside its session's scope, because the database itself refuses.
--
-- These are the baseline policies establishable from the schema alone at
-- Phase 1. Later phases (3: lead-scoped roster/applicant visibility, 4:
-- approval-queue scoping, 8: admin reporting) may extend these via
-- further migrations as their exact query shapes are implemented — per
-- ADR-0004, RLS is a backstop, not the primary authorization mechanism,
-- so a deliberately conservative starting policy set here is the correct
-- default-deny posture, not a gap.

create or replace function current_actor_id()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- SECURITY DEFINER: looking up the current actor's role requires reading
-- `volunteer`, which is itself RLS-protected. A SECURITY DEFINER function
-- (owned by the migration/table-owner role, never the non-owner app role)
-- is the standard Postgres pattern for this kind of policy-support lookup
-- without infinite recursion through RLS. search_path is pinned to avoid
-- search-path-hijack attacks against SECURITY DEFINER functions.
create or replace function current_actor_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select role from volunteer where id = current_actor_id()
$$;

-- SECURITY DEFINER for the same reason as current_actor_role(), plus one
-- more: a policy on `project_lead` itself that queried `project_lead`
-- directly (even via an alias) would recurse — Postgres re-applies
-- project_lead's own RLS policy to evaluate the subquery, which
-- references project_lead again, forever. Routing every "is the current
-- actor a lead of this project" check (including project_lead's own
-- policies) through this single SECURITY DEFINER function avoids that
-- recursion by construction, since the function body runs as its
-- (RLS-exempt) owner rather than re-entering RLS at all.
create or replace function is_lead_of_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from project_lead
        where project_id = p_project_id and volunteer_id = current_actor_id()
    )
$$;

-- volunteer -------------------------------------------------------------

alter table volunteer enable row level security;
alter table volunteer force row level security;

create policy volunteer_select on volunteer
    for select
    using (id = current_actor_id() or current_actor_role() = 'admin');

create policy volunteer_insert on volunteer
    for insert
    with check (id = current_actor_id());

create policy volunteer_update on volunteer
    for update
    using (id = current_actor_id() or current_actor_role() = 'admin')
    with check (id = current_actor_id() or current_actor_role() = 'admin');

revoke delete on volunteer from public;

-- identity (OAuth links) --------------------------------------------------

alter table identity enable row level security;
alter table identity force row level security;

create policy identity_select on identity
    for select
    using (volunteer_id = current_actor_id() or current_actor_role() = 'admin');

create policy identity_insert on identity
    for insert
    with check (volunteer_id = current_actor_id() or current_actor_role() = 'admin');

create policy identity_update on identity
    for update
    using (volunteer_id = current_actor_id() or current_actor_role() = 'admin')
    with check (volunteer_id = current_actor_id() or current_actor_role() = 'admin');

revoke delete on identity from public;

-- project -----------------------------------------------------------------

alter table project enable row level security;
alter table project force row level security;

create policy project_select on project
    for select
    using (
        status = 'open'
        or current_actor_role() = 'admin'
        or is_lead_of_project(project.id)
    );

create policy project_insert on project
    for insert
    with check (current_actor_role() in ('lead', 'admin'));

create policy project_update on project
    for update
    using (current_actor_role() = 'admin' or is_lead_of_project(project.id))
    with check (current_actor_role() = 'admin' or is_lead_of_project(project.id));

revoke delete on project from public;

-- project_lead --------------------------------------------------------------

alter table project_lead enable row level security;
alter table project_lead force row level security;

create policy project_lead_select on project_lead
    for select
    using (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or is_lead_of_project(project_lead.project_id)
    );

create policy project_lead_insert on project_lead
    for insert
    with check (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or is_lead_of_project(project_lead.project_id)
    );

create policy project_lead_delete on project_lead
    for delete
    using (current_actor_role() = 'admin' or is_lead_of_project(project_lead.project_id));

-- assignment ------------------------------------------------------------

alter table assignment enable row level security;
alter table assignment force row level security;

create policy assignment_select on assignment
    for select
    using (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or is_lead_of_project(assignment.project_id)
    );

create policy assignment_insert on assignment
    for insert
    with check (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or is_lead_of_project(assignment.project_id)
    );

-- Approve/remove/reassign is lead- or admin-scoped only, never the
-- assignment's own volunteer (concept.md section 4: leads approve
-- applicants).
create policy assignment_update on assignment
    for update
    using (current_actor_role() = 'admin' or is_lead_of_project(assignment.project_id))
    with check (current_actor_role() = 'admin' or is_lead_of_project(assignment.project_id));

revoke delete on assignment from public;

-- hour_entry --------------------------------------------------------------

alter table hour_entry enable row level security;
alter table hour_entry force row level security;

create policy hour_entry_select on hour_entry
    for select
    using (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or exists (
            select 1 from assignment a
            where a.id = hour_entry.assignment_id and is_lead_of_project(a.project_id)
        )
    );

-- Self-logged only (concept.md section 5).
create policy hour_entry_insert on hour_entry
    for insert
    with check (volunteer_id = current_actor_id());

-- Approve/reject/adjust is lead- or admin-scoped, never the entry's own
-- volunteer (hours-verification.md's "Other invariants").
create policy hour_entry_update on hour_entry
    for update
    using (
        current_actor_role() = 'admin'
        or exists (
            select 1 from assignment a
            where a.id = hour_entry.assignment_id and is_lead_of_project(a.project_id)
        )
    )
    with check (
        current_actor_role() = 'admin'
        or exists (
            select 1 from assignment a
            where a.id = hour_entry.assignment_id and is_lead_of_project(a.project_id)
        )
    );

revoke delete on hour_entry from public;

-- audit_log -----------------------------------------------------------------

alter table audit_log enable row level security;
alter table audit_log force row level security;

-- Admin audit-trail views only, per compliance-audit.md.
create policy audit_log_select on audit_log
    for select
    using (current_actor_role() = 'admin');

-- Written only by the apps/api scoped-transaction helper (Prompt 1.4), in
-- the same transaction as the mutation it records, using that mutation's
-- own actor scope — actor_id therefore always equals current_actor_id()
-- for a human actor. `actor_id is null` is permitted for a future
-- System-actor scope (scheduled jobs, Phase 5/7) with no corresponding
-- volunteer row.
create policy audit_log_insert on audit_log
    for insert
    with check (actor_id = current_actor_id() or actor_id is null);

revoke update, delete on audit_log from public;
