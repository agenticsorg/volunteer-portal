-- Prompt 2.2: account-linking policy support. Login/signup must be able
-- to check for an existing OAuth identity, or an existing *verified*
-- identity under a different provider with the same email (ADR-0007's
-- collision check), across *every* volunteer -- not just the caller's
-- own row, which is all the identity_select RLS policy (Prompt 1.2)
-- otherwise permits for a non-admin actor. These SECURITY DEFINER
-- functions expose only the narrow (volunteer_id, provider) result the
-- login flow needs, never arbitrary identity-table data, following the
-- same pattern as current_actor_role()/is_lead_of_project().

create or replace function find_volunteer_id_by_oauth_identity(p_provider text, p_provider_user_id text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select volunteer_id from identity
    where provider = p_provider and provider_user_id = p_provider_user_id
    limit 1
$$;

create or replace function find_verified_identity_email_collision(p_email text)
returns table(volunteer_id uuid, provider text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select volunteer_id, provider from identity
    where lower(email) = lower(p_email) and email_verified = true
    limit 1
$$;
