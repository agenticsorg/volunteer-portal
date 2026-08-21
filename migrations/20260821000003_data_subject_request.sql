-- Prompt 10.2, per compliance-audit.md's "Aggregate: DataSubjectRequest"
-- section: PIPEDA/GDPR export and deletion requests as a first-class
-- process with a lifecycle, not an ad hoc admin script run once and
-- forgotten. `audit_log.entity_type`'s 'data_subject_request' value
-- (migration 20260819000001) already anticipated this table.

create table data_subject_request (
    id uuid primary key default gen_random_uuid(),
    volunteer_id uuid not null references volunteer (id),
    request_type text not null check (request_type in ('export', 'deletion')),
    status text not null default 'received'
        check (status in ('received', 'in_progress', 'completed', 'rejected')),
    requested_at timestamptz not null default now(),
    completed_at timestamptz,
    handled_by uuid references volunteer (id),
    rejection_reason text,
    -- Invariant 1: Rejected requires a non-empty rejection_reason.
    constraint data_subject_request_rejection_reason_required check (
        status != 'rejected' or (rejection_reason is not null and btrim(rejection_reason) != '')
    ),
    -- Invariant 3: handled_by is required before Completed or Rejected.
    constraint data_subject_request_handled_by_required check (
        status not in ('completed', 'rejected') or handled_by is not null
    )
);

create index data_subject_request_volunteer_id_idx on data_subject_request (volunteer_id);
create index data_subject_request_status_idx on data_subject_request (status) where status in ('received', 'in_progress');

alter table data_subject_request enable row level security;
alter table data_subject_request force row level security;

-- The requesting volunteer can see their own request's status; an admin
-- (who must handle it) can see all, matching hour_entry_select's
-- "self or admin" shape.
create policy data_subject_request_select on data_subject_request
    for select
    using (volunteer_id = current_actor_id() or current_actor_role() = 'admin');

-- A volunteer files their own request; an admin may also file one on a
-- volunteer's behalf (e.g. a request received by email rather than
-- through the app).
create policy data_subject_request_insert on data_subject_request
    for insert
    with check (volunteer_id = current_actor_id() or current_actor_role() = 'admin');

-- Status transitions (start/complete/reject) are admin-only per
-- invariant 3 (handled_by must resolve to Role::Admin) -- the requesting
-- volunteer never updates their own request's lifecycle.
create policy data_subject_request_update on data_subject_request
    for update
    using (current_actor_role() = 'admin')
    with check (current_actor_role() = 'admin');

revoke delete on data_subject_request from public;

grant select, insert, update on data_subject_request to app_user;

-- compliance-audit.md's anonymization spec sets `Volunteer.oauth_links`
-- to `vec![]`; `identity`'s rows carry `email` (email_at_link_time),
-- itself personally identifying data that anonymization must
-- irrecoverably remove, not merely orphan. `VolunteerRepository::save`
-- (Prompt 1.3) now deletes-then-reinserts `identity` rows to stay in
-- sync with the in-memory `oauth_links`, so this delete path is
-- exercised on every save, not only anonymization -- admin-only (an
-- admin actioning a deletion request runs under their own
-- `begin_scoped(admin_id)`, never the target volunteer's own session).
create policy identity_delete on identity
    for delete
    using (current_actor_role() = 'admin');

grant delete on identity to app_user;
