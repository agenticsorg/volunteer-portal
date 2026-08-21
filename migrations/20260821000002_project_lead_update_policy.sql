-- Prompt 8.2's audit-coverage suite found a real gap: migration
-- 20260819000002 defined `project_lead_select`/`project_lead_insert`/
-- `project_lead_delete` but never `project_lead_update`. Under `force
-- row level security` with no UPDATE policy defined, Postgres denies
-- every UPDATE on the table by default -- including the `on conflict
-- (project_id, volunteer_id) do update set role = excluded.role` branch
-- of `SqlxProjectRepository::save()`'s lead-upsert (repository.rs), which
-- fires whenever `Project::add_lead` is saved against a project that
-- already has at least one persisted lead (i.e. every real call except
-- a brand-new project's very first save, where every lead row is a
-- fresh insert with nothing to conflict on -- exactly why this went
-- undetected until a test exercised `add_lead` as a *second*, later
-- mutation rather than bundling every lead into the initial
-- `Project::create` + first `save()`).
--
-- Same shape as `project_lead_insert`/`project_lead_delete`: an admin
-- (global scope) or a current lead of the project (who is, by
-- definition, updating their own or a co-lead's row).

create policy project_lead_update on project_lead
    for update
    using (current_actor_role() = 'admin' or is_lead_of_project(project_lead.project_id))
    with check (current_actor_role() = 'admin' or is_lead_of_project(project_lead.project_id));
