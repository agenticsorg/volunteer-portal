-- Prompt 5.1: Discord Integration's two owned tables (discord-integration.md
-- "Repository/port shapes") — a link-confirmation record and an operational
-- reconcile-run log, deliberately separate from audit_log (a routine
-- reconcile run is a System-actor operational event, not a compliance
-- record; see discord-integration.md's "Domain events" section).
--
-- Both need a genuine System-actor RLS allowance: the scheduled reconcile
-- job runs with no corresponding volunteer row, so `current_actor_id()` is
-- NULL for its transactions (kernel::ScopedDb::begin_system_scoped, this
-- prompt) — the same "actor_id is null ... future System-actor scope
-- (scheduled jobs, Phase 5/7)" case audit_log's own INSERT policy already
-- anticipated back in Prompt 1.4.

create table discord_link (
    id uuid primary key default gen_random_uuid(),
    volunteer_id uuid not null references volunteer (id),
    discord_id text not null,
    linked_at timestamptz not null default now()
);

-- One link record per volunteer -- re-linking updates the existing row
-- (supports "don't re-emit DiscordLinkCompleted for an already-linked
-- pair" idempotency per discord-integration.md).
create unique index discord_link_volunteer_id_key on discord_link (volunteer_id);
create index discord_link_discord_id_idx on discord_link (discord_id);

alter table discord_link enable row level security;
alter table discord_link force row level security;

create policy discord_link_select on discord_link
    for select
    using (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or current_actor_id() is null
    );

create policy discord_link_insert on discord_link
    for insert
    with check (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or current_actor_id() is null
    );

create policy discord_link_update on discord_link
    for update
    using (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or current_actor_id() is null
    )
    with check (
        volunteer_id = current_actor_id()
        or current_actor_role() = 'admin'
        or current_actor_id() is null
    );

revoke delete on discord_link from public;

create table reconcile_run_log (
    id uuid primary key default gen_random_uuid(),
    desynced_count int not null,
    corrected_count int not null,
    failed_count int not null default 0,
    ran_at timestamptz not null default now()
);

alter table reconcile_run_log enable row level security;
alter table reconcile_run_log force row level security;

-- Admin-facing monitoring view, or the System actor itself (no human
-- session) writing/reading its own run history.
create policy reconcile_run_log_select on reconcile_run_log
    for select
    using (current_actor_role() = 'admin' or current_actor_id() is null);

create policy reconcile_run_log_insert on reconcile_run_log
    for insert
    with check (current_actor_id() is null);

revoke update, delete on reconcile_run_log from public;

grant select, insert, update on discord_link to app_user;
grant select, insert on reconcile_run_log to app_user;
