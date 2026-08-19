-- Prompt 4.2: the same RLS + upsert WITH CHECK bug found in Prompt 1.4's
-- volunteer_insert policy. `SqlxHourEntryRepository::save` uses a single
-- `insert ... on conflict (id) do update` statement for both the true
-- self-logged insert and every later lead/admin-driven approve/reject/
-- adjust update -- but Postgres evaluates the INSERT policy's WITH CHECK
-- even on the ON CONFLICT DO UPDATE path, so a lead approving someone
-- else's entry was rejected with "new row violates row-level security
-- policy for table hour_entry" (volunteer_id != current_actor_id()).
-- Widened to match hour_entry_update's WITH CHECK: self-insert is still
-- the only way a *new* row can appear (nothing else can supply a
-- previously-unseen id), while a lead/admin's update through the same
-- upsert statement now also satisfies the check.

drop policy hour_entry_insert on hour_entry;

create policy hour_entry_insert on hour_entry
    for insert
    with check (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or exists (
            select 1 from assignment a
            where a.id = hour_entry.assignment_id and is_lead_of_project(a.project_id)
        )
    );
