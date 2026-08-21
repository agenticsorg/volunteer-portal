-- Prompt 7.1: the transactional outbox (context-map.md mechanism "b")
-- and Notifications' own delivery-log table, per notifications.md.
--
-- Also widens `project_select` to allow System-actor reads
-- (`current_actor_id() is null`) -- explicitly deferred by migration
-- 20260819000011's architect review, pending exactly this need: the
-- meeting-reminder job (this prompt) runs under
-- `kernel::ScopedDb::begin_system_scoped()` and must be able to read
-- `project` rows regardless of `status` -- a project whose registration
-- has since closed can still have an upcoming `next_occurrence_at` that
-- attendees need reminding about.

drop policy project_select on project;

create policy project_select on project
    for select
    using (
        status = 'open'
        or current_actor_role() = 'admin'
        or is_lead_of_project(project.id)
        or current_actor_id() is null
    );

-- context-map.md mechanism "b": every `AuditableEvent`-adjacent event
-- that Notifications (or a future Discord Integration debounce trigger)
-- reacts to is additionally written here, in the same transaction as
-- the aggregate save (`kernel::record_outbox_events`). One shared table,
-- not per-context, matching this project's single-schema RLS model.
create table domain_event_outbox (
    id uuid primary key default gen_random_uuid(),
    event_type text not null,
    payload jsonb not null,
    occurred_at timestamptz not null,
    processed_at timestamptz,
    attempts int not null default 0,
    created_at timestamptz not null default now()
);

create index domain_event_outbox_unprocessed_idx on domain_event_outbox (occurred_at)
    where processed_at is null;

alter table domain_event_outbox enable row level security;
alter table domain_event_outbox force row level security;

-- Written from any authenticated actor's mutation (a volunteer's own
-- signup, a lead's assignment approval, an admin's hours approval, a
-- volunteer's own verification-letter request) -- there is no "owns this
-- row" concept for an outbox entry the way there is for e.g.
-- `discord_link`, so insert is unrestricted by actor identity, same as
-- `audit_log_insert`. Only the System-actor poller job ever selects or
-- marks rows processed; admins may additionally read for debugging.
create policy domain_event_outbox_insert on domain_event_outbox
    for insert
    with check (true);

create policy domain_event_outbox_select on domain_event_outbox
    for select
    using (current_actor_id() is null or current_actor_role() = 'admin');

create policy domain_event_outbox_update on domain_event_outbox
    for update
    using (current_actor_id() is null)
    with check (current_actor_id() is null);

revoke delete on domain_event_outbox from public;

-- notifications.md's flat delivery-log record -- no aggregate, no
-- lifecycle beyond "attempted, then sent or failed" (see that file's
-- "No aggregate root" section for why this deliberately isn't a rich
-- aggregate).
create table notification_attempt (
    id uuid primary key default gen_random_uuid(),
    trigger_type text not null
        check (trigger_type in (
            'signup_confirmation', 'assignment_approved', 'hours_approved',
            'meeting_reminder', 'verification_letter_ready'
        )),
    recipient_id uuid not null references volunteer (id),
    channel text not null check (channel in ('email', 'discord_dm')),
    source_event_id uuid references domain_event_outbox (id),
    project_id uuid references project (id),
    next_occurrence_at timestamptz,
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
    attempted_at timestamptz not null default now(),
    error text
);

-- Two independent idempotency lookups, per notifications.md's
-- "Idempotency" section -- deliberately plain (non-unique) indexes, not
-- unique constraints: build-roadmap.md's Phase 7 exit criterion requires
-- a failed send to be *retried* on the next poller tick, which means a
-- `Failed` row must not block a later attempt for the same
-- `source_event_id`/occurrence from ever being inserted. Idempotency is
-- instead enforced in application code
-- (`NotificationAttemptRepository::exists_for_source_event`/
-- `exists_for_occurrence`, both `status = 'sent'`-scoped) -- a row
-- existing at all is not "already handled", only a *sent* one is. This
-- also means `find_by_recipient` naturally surfaces the full retry
-- history (every failed attempt plus the eventual success, or a
-- persistent failure), which is exactly the admin-debugging visibility
-- notifications.md's "Domain events" section describes.
create index notification_attempt_source_event_idx
    on notification_attempt (source_event_id)
    where source_event_id is not null;

create index notification_attempt_occurrence_idx
    on notification_attempt (trigger_type, recipient_id, project_id, next_occurrence_at)
    where project_id is not null and next_occurrence_at is not null;

create index notification_attempt_recipient_idx on notification_attempt (recipient_id);

alter table notification_attempt enable row level security;
alter table notification_attempt force row level security;

-- Admin/debugging visibility (notifications.md: "an admin investigating
-- 'did volunteer X get their letter email' queries Notifications"), the
-- recipient's own visibility into their own delivery history, or the
-- System-actor poller/reminder job itself.
create policy notification_attempt_select on notification_attempt
    for select
    using (
        recipient_id = current_actor_id()
        or current_actor_role() = 'admin'
        or current_actor_id() is null
    );

-- Only the System-actor poller/reminder job ever creates or updates a
-- delivery-attempt record -- no HTTP-facing handler writes this table
-- directly.
create policy notification_attempt_insert on notification_attempt
    for insert
    with check (current_actor_id() is null);

create policy notification_attempt_update on notification_attempt
    for update
    using (current_actor_id() is null)
    with check (current_actor_id() is null);

revoke delete on notification_attempt from public;

grant select, insert, update on domain_event_outbox, notification_attempt to app_user;
