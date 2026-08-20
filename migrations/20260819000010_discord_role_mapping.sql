-- Prompt 5.1: the guild-specific config table backing `DiscordRoleMapping`
-- (discord-integration.md: "Translation to and from Discord's actual role
-- IDs happens through a port, implemented in infra against a guild-specific
-- configuration mapping (not hardcoded)"). One row per managed role concept:
-- `project_id is null` is the single `BaseVolunteer` row; `project_id`
-- set is a `ProjectMember(project_id)` row. Populated by an admin once a
-- project's Discord role has actually been created in the guild -- a
-- `ProjectMember` role with no row here is the "brand-new project whose
-- Discord role hasn't been created yet" case discord-integration.md's
-- `DiscordRoleMapping::resolve` doc comment describes: reconcile skips
-- that volunteer's project-role line and logs it, rather than failing.

create table discord_role_mapping (
    id uuid primary key default gen_random_uuid(),
    project_id uuid references project (id),
    discord_role_id text not null,
    created_at timestamptz not null default now()
);

-- Exactly one BaseVolunteer row (project_id is null), and at most one
-- mapping row per project.
create unique index discord_role_mapping_base_key on discord_role_mapping ((project_id is null))
    where project_id is null;
create unique index discord_role_mapping_project_id_key on discord_role_mapping (project_id)
    where project_id is not null;

alter table discord_role_mapping enable row level security;
alter table discord_role_mapping force row level security;

-- Admin-managed config, and readable by the System-actor reconcile job
-- (current_actor_id() is null -- see migration 20260819000009's note on
-- kernel::ScopedDb::begin_system_scoped).
create policy discord_role_mapping_select on discord_role_mapping
    for select
    using (current_actor_role() = 'admin' or current_actor_id() is null);

create policy discord_role_mapping_insert on discord_role_mapping
    for insert
    with check (current_actor_role() = 'admin');

create policy discord_role_mapping_update on discord_role_mapping
    for update
    using (current_actor_role() = 'admin')
    with check (current_actor_role() = 'admin');

create policy discord_role_mapping_delete on discord_role_mapping
    for delete
    using (current_actor_role() = 'admin');

grant select, insert, update, delete on discord_role_mapping to app_user;
