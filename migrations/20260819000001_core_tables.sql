-- Prompt 1.2: core schema. Six tables — concept.md's original four
-- (volunteer, project, assignment, hour_entry) plus the two ADR-0005
-- added (audit_log, project_lead) — plus `identity` (ADR-0007's OAuth
-- link table).

create extension if not exists pgcrypto;

-- Identity & Access: Volunteer aggregate (identity-access.md).
create table volunteer (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) > 0),
    email text not null,
    discord_id text,
    timezone text not null,
    skills text[] not null default '{}',
    availability jsonb not null default '{}'::jsonb,
    status text not null default 'pending_approval'
        check (status in ('pending_approval', 'approved', 'suspended')),
    role text not null default 'volunteer'
        check (role in ('volunteer', 'lead', 'admin')),
    code_of_conduct_accepted_at timestamptz,
    ip_agreement_accepted_at timestamptz,
    age_attestation_confirmed_at timestamptz,
    created_at timestamptz not null default now()
);

-- email is required and unique per identity-access.md invariant 2.
create unique index volunteer_email_key on volunteer (lower(email));

-- discord_id is unique across volunteers when present, per
-- identity-access.md invariant 4.
create unique index volunteer_discord_id_key on volunteer (discord_id)
    where discord_id is not null;

-- Identity & Access: OAuthLink (identity-access.md's `OAuthLink`, named
-- `identity` per ADR-0007's table-naming context).
create table identity (
    id uuid primary key default gen_random_uuid(),
    volunteer_id uuid not null references volunteer (id),
    provider text not null check (provider in ('discord', 'google')),
    provider_user_id text not null,
    email text not null,
    email_verified boolean not null default false,
    linked_at timestamptz not null default now(),
    unique (provider, provider_user_id)
);

create index identity_volunteer_id_idx on identity (volunteer_id);

-- Projects & Assignments: Project aggregate, covering both "project" and
-- "event" via a `type` discriminator (amended ADR-0006,
-- projects-assignments.md).
create table project (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) > 0 and char_length(name) <= 200),
    description text not null default '',
    type text not null check (type in ('project', 'event')),
    needed_skills text[] not null default '{}',
    status text not null default 'open' check (status in ('open', 'closed')),
    -- EventSchedule columns: meaningful only when type = 'event', per
    -- projects-assignments.md invariant 5.
    next_occurrence_at timestamptz,
    recurrence_note text,
    created_at timestamptz not null default now(),
    constraint project_schedule_matches_type check (
        (type = 'event' and next_occurrence_at is not null)
        or (type = 'project' and next_occurrence_at is null and recurrence_note is null)
    )
);

-- Projects & Assignments: ProjectLead join table (ADR-0005), replacing a
-- single `Project.lead_id` FK from the start.
create table project_lead (
    project_id uuid not null references project (id),
    volunteer_id uuid not null references volunteer (id),
    role text not null default 'lead',
    assigned_at timestamptz not null default now(),
    primary key (project_id, volunteer_id)
);

-- Projects & Assignments: Assignment aggregate, including the
-- `participation_mode` column that is the concrete mechanism behind the
-- amended ADR-0006 event-hours rule. Set once at insert time; the
-- `assignment_participation_mode_immutable` trigger below (defined after
-- the column exists) prevents it from ever being updated.
create table assignment (
    id uuid primary key default gen_random_uuid(),
    volunteer_id uuid not null references volunteer (id),
    project_id uuid not null references project (id),
    role text not null,
    participation_mode text not null check (participation_mode in ('contributor', 'attendee')),
    status text not null default 'applied' check (status in ('applied', 'approved', 'removed')),
    applied_at timestamptz not null default now(),
    decided_by uuid references volunteer (id),
    decided_at timestamptz,
    -- Attendee-mode signup/attendance tracking (ADR-0006: "a boolean or
    -- timestamp attended_at on Assignment"); unused for Contributor mode.
    attended_at timestamptz
);

create index assignment_volunteer_id_idx on assignment (volunteer_id);
create index assignment_project_id_idx on assignment (project_id);

create or replace function assignment_participation_mode_immutable()
returns trigger
language plpgsql
as $$
begin
    if new.participation_mode is distinct from old.participation_mode then
        raise exception 'assignment.participation_mode is immutable after creation (ADR-0006)';
    end if;
    return new;
end;
$$;

create trigger assignment_participation_mode_immutable_trg
    before update on assignment
    for each row
    execute function assignment_participation_mode_immutable();

-- Hours & Verification: HourEntry aggregate (hours-verification.md),
-- including the adjustment_* columns for ADR-0005's audit-trail
-- requirement (concept.md section 8: "manual hour adjustment with a
-- visible audit trail").
create table hour_entry (
    id uuid primary key default gen_random_uuid(),
    volunteer_id uuid not null references volunteer (id),
    assignment_id uuid not null references assignment (id),
    date date not null,
    hours numeric(4, 2) not null check (hours > 0 and hours <= 24),
    description text not null check (char_length(btrim(description)) > 0),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    approver_id uuid references volunteer (id),
    decided_at timestamptz,
    adjustment_adjusted_by uuid references volunteer (id),
    adjustment_previous_hours numeric(4, 2),
    adjustment_reason text,
    adjustment_adjusted_at timestamptz,
    created_at timestamptz not null default now(),
    constraint hour_entry_adjustment_reason_required check (
        adjustment_adjusted_by is null or (adjustment_reason is not null and char_length(btrim(adjustment_reason)) > 0)
    )
);

create index hour_entry_volunteer_id_idx on hour_entry (volunteer_id);
create index hour_entry_assignment_id_idx on hour_entry (assignment_id);
create index hour_entry_status_idx on hour_entry (status);

-- Compliance & Audit: AuditLog (ADR-0005 exact columns, entity_type
-- extended with 'data_subject_request' per compliance-audit.md).
create table audit_log (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid references volunteer (id),
    action text not null,
    entity_type text not null check (
        entity_type in ('volunteer', 'project', 'assignment', 'hour_entry', 'data_subject_request')
    ),
    entity_id uuid not null,
    before jsonb,
    after jsonb,
    created_at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity_type, entity_id);
create index audit_log_actor_id_idx on audit_log (actor_id);
create index audit_log_created_at_idx on audit_log (created_at);
