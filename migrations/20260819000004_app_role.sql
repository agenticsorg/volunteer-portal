-- Prompt 1.2: the application's database role must not be a table owner
-- (ADR-0004's single highest-priority security-review item) — Postgres
-- table owners bypass RLS policies by default regardless of policy
-- definitions. `app_user` is created here as a non-owner role; the
-- migrations themselves run as the connection's original (owner) role.
--
-- The password below is a local-dev/CI default only. Production
-- (Neon) must provision this role's real credential via Neon's own role
-- management, not by relying on this literal value — see .env.example.

do $$
begin
    if not exists (select from pg_catalog.pg_roles where rolname = 'app_user') then
        create role app_user login password 'app_user_dev_password';
    end if;
end
$$;

grant usage on schema public to app_user;

grant select, insert, update on volunteer, identity, project, project_lead, assignment, hour_entry to app_user;
grant select, insert on audit_log to app_user;

-- No sequences to grant (all PKs are gen_random_uuid()-defaulted, not
-- serial), so no further USAGE grants are needed for the app role to
-- insert rows.
