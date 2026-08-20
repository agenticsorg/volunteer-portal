# ADR-0014: Data Privacy and Compliance Architecture

## Status
Accepted — 2026-08-10

## Context
The Volunteer Portal serves an international volunteer base for Agentics Foundation, an AI/open-source nonprofit. Research (`docs/research/05-domain-and-compliance.md`) establishes that GDPR is the strictest applicable regime and the correct baseline: any EU/EEA-resident volunteer is covered regardless of the org's nonprofit status, and building to GDPR satisfies PIPEDA and CCPA/CPRA concerns as a side effect (nonprofits are largely exempt from the latter two, but GDPR has no such exemption).

Concrete obligations established by the research that this ADR must satisfy:

- A **documented lawful basis per processing purpose** — volunteer agreement (contract), newsletters/photo publication (consent), training analytics (legitimate interest) are not interchangeable and must be recorded per purpose, not as one global "accepted terms" flag.
- **Video/training data is personal data**: watch duration, progress, quiz results, and completion timestamps are learning analytics under GDPR and need their own basis.
- **Gamification leaderboards publish behavioral data** (points, badges, rank) and need an explicit opt-out, separate from core service consent.
- **DSAR machinery**: export-all-my-data and delete/erasure paths that survive foreign keys. Hour records in particular must be **anonymized, not hard-deleted**, because approved hours are needed in aggregate for grant reporting (funders value volunteer time at the Independent Sector rate and require dates/timestamps/sign-off in rollups that must survive an individual's erasure request).
- **Retention limits per data class** (inactive volunteer PII, video watch events, moderation logs) enforced by automated expiry, not manual review.
- **Audit trail on every privileged action** — hour approval, role grant, data export, moderation action — as a day-one requirement, not a later hardening pass.
- **Age gating**: DOB or 16+ attestation at signup, with guardian authorization required for GDPR consent below age 16.

This decision fixes the schema and job design for all of the above, consistent with the modular-monolith/per-schema-with-outbox architecture (ADR-0002/0003, referenced by the canonical decisions) and with Prisma multi-schema mode, ULIDs, and graphile-worker as the background job runner.

## Decision
Implement compliance as first-class schema + background-job infrastructure inside the `identity` and `admin` schemas, integrated with the transactional outbox pattern already used for cross-context events.

### 1. `identity.consent_records`
```sql
create table identity.consent_records (
  id               text primary key,               -- ULID
  subject_id       text not null references identity.users(id),
  purpose          text not null,                   -- enum-like, see below
  policy_version   text not null,                    -- e.g. 'privacy-policy@2026-08-01'
  status           text not null,                    -- 'granted' | 'revoked'
  granted_at       timestamptz,
  revoked_at       timestamptz,
  source           text not null,                    -- 'signup_form' | 'settings_page' | 'admin_backfill'
  ip_address       inet,
  user_agent       text,
  created_at       timestamptz not null default now()
);

create index consent_records_subject_purpose_idx
  on identity.consent_records (subject_id, purpose, created_at desc);
```
`purpose` is a closed set enforced at the application layer (not a DB enum, to avoid migration lock-in): `newsletter`, `photo_name_publication`, `leaderboard_participation`, `analytics_cookies`, `training_analytics`, `marketing_email`. Core-service processing (account creation, hour logging, opportunity sign-up) runs on **contract** or **legitimate interest** basis and is *not* stored as a consent row — only genuinely optional, purpose-specific processing gets a consent record, per the research's finding that these bases are not interchangeable.

Every row is append-only. "Current" consent for a purpose is the latest row by `created_at`; granting or revoking always inserts a new row rather than updating one, so the full consent history — including exact policy version accepted — is preserved for audit and legal defensibility. A `identity.consent_current` view exposes `distinct on (subject_id, purpose) ... order by subject_id, purpose, created_at desc` for fast reads.

### 2. DSAR pipeline (graphile-worker jobs)
Two jobs, triggered by a subject-initiated request recorded in `identity.dsar_requests`:

```sql
create table identity.dsar_requests (
  id            text primary key,
  subject_id    text not null references identity.users(id),
  type          text not null,        -- 'export' | 'erase'
  status        text not null default 'pending', -- pending|processing|completed|failed
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  result_url    text,                 -- signed R2 URL for export bundles, expires in 7 days
  failure_reason text
);
```

- **`dsar_export_all` job**: fans out a read query per schema (identity, volunteering, training, gamification, community, notifications — each schema owns its own export function, e.g. `volunteering.export_subject_data(subject_id)`, returning JSON) via the graphile-worker job, assembles a single JSON+CSV bundle, uploads to a private R2 bucket path (`dsar-exports/{request_id}/`), generates a signed URL with 7-day expiry, and emails the volunteer via Resend. No schema reaches into another schema's tables directly — each schema's export function is invoked through its own Prisma client, respecting the no-cross-schema-FK boundary.
- **`dsar_erase_subject` job**: two-phase.
  1. **Anonymize-in-place** for records needed in aggregate: `volunteering.hour_entries` — actor's name/contact fields are nulled, `subject_id` is replaced with a stable per-request anonymization token (`anon_<ulid>`) so date/duration/program/approver rollups for grant reporting remain intact, but the row is no longer attributable to a real identity. `community.posts` authored by the subject are similarly anonymized (`author_display = 'Deleted User'`) rather than removed, to preserve thread integrity.
  2. **Hard-delete** for records with no aggregate/legal-retention need: `identity.consent_records` older than the active ones, session tokens, notification preferences, uploaded profile photos (R2 object deleted), and the `identity.users` row itself is anonymized (email replaced with `deleted+<ulid>@agentics.invalid`, name cleared) rather than deleted outright, because `role_assignments` and `hour_entries.approver_id` may still reference it as an *approver* — a login identity that no longer authenticates but preserves referential integrity.

Both jobs write a completion event to `identity.domain_events` (the schema's outbox) so downstream schemas (training, gamification) can react — e.g., gamification zeroing out a leaderboard display name — without an in-process cross-schema call.

Erasure has documented exceptions surfaced to the subject at request time: hour totals persist in anonymized/aggregate form for grant compliance (a legitimate-interest override under GDPR Art. 17(3)(b) — legal obligation to funders), and moderation logs referencing the subject as an actor in a code-of-conduct action are retained per the retention policy below rather than erased immediately, since they may be needed to defend a past enforcement decision.

### 3. Retention policy configuration
```sql
create table admin.retention_policies (
  id              text primary key,
  data_class      text not null unique,   -- 'inactive_volunteer_pii', 'video_watch_events', 'moderation_logs', 'dsar_export_bundles', 'session_tokens'
  retention_days  int not null,
  action          text not null,          -- 'anonymize' | 'hard_delete'
  enabled         boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by      text references identity.users(id)
);
```
Seeded defaults: `inactive_volunteer_pii` = 730 days since last login → anonymize; `video_watch_events` = 365 days → hard_delete (raw event granularity; aggregated completion state is retained separately as it's needed for certificates); `moderation_logs` = 1095 days (3 years) → anonymize actor references, retain action/reason; `dsar_export_bundles` = 7 days → hard_delete (R2 lifecycle rule mirrors this); `session_tokens` = 30 days past expiry → hard_delete.

A recurring graphile-worker job (`retention_sweep`, scheduled hourly via `run_at` cron helper) reads `admin.retention_policies` where `enabled = true`, and for each data class invokes a schema-owned sweep function (e.g. `training.sweep_watch_events(cutoff)`), keeping the "how do I query/mutate my own tables" logic inside the owning schema. Sweep runs are themselves audit-logged (`resource = 'retention_policy', action = 'sweep_executed'`) with row counts affected.

### 4. `admin.audit_log`
A single dedicated table in the `admin` schema, not duplicated per schema, since audit entries are inherently cross-cutting and read by admins as one timeline. Other schemas emit an audit event via their own `domain_events` outbox; a graphile-worker consumer (`audit_log_writer`) drains all schemas' outboxes for events tagged `audit: true` and appends to `admin.audit_log`. This keeps the write path append-only and decoupled — a schema never writes directly into another schema's table.

```sql
create table admin.audit_log (
  id             text primary key,        -- ULID, sortable by time
  occurred_at    timestamptz not null default now(),
  actor_id       text,                    -- identity.users.id of who did it; null for system jobs
  actor_type     text not null,           -- 'user' | 'system' | 'service_job'
  action         text not null,           -- 'hour.approved' | 'role.granted' | 'data.exported' | 'moderation.user_suspended' ...
  resource_type  text not null,           -- 'hour_entry' | 'role_assignment' | 'dsar_request' | 'community_post' ...
  resource_id    text not null,
  scope_type     text,                    -- 'chapter' | 'global', mirrors role_assignments scoping
  scope_id       text,
  before_state   jsonb,
  after_state    jsonb,
  metadata       jsonb not null default '{}',
  ip_address     inet,
  request_id     text                     -- correlates to OpenTelemetry trace id
);

create index audit_log_actor_idx on admin.audit_log (actor_id, occurred_at desc);
create index audit_log_resource_idx on admin.audit_log (resource_type, resource_id, occurred_at desc);
create index audit_log_action_idx on admin.audit_log (action, occurred_at desc);
```
`resource_id` references other schemas' entities **by ID only, never by FK**, consistent with the no-cross-schema-FK rule. The table is insert-only at the application/DB-role level: the app's Postgres role has no `UPDATE`/`DELETE` grant on `admin.audit_log`; corrections are new rows, never edits.

Every privileged action funnels through a single `recordAuditEvent()` helper in the shared `packages/audit` internal library, called synchronously in the same transaction as the privileged write (hour approval, role grant, DSAR completion, moderation action) by writing to that schema's `domain_events` outbox with `audit: true` — so the audit trail is guaranteed at-least-once even if the drain worker lags, and never silently dropped by a failed fire-and-forget call.

### 5. Age gating at signup
Signup requires either a DOB field or an explicit 16+ attestation checkbox (configurable per deployment; DOB is preferred since it also supports minimum-age program eligibility beyond privacy law). `identity.users` stores `date_of_birth` (nullable, encrypted at rest via Postgres column-level pgcrypto is **not** used — full-disk/managed encryption from Neon/Supabase is deemed sufficient per ADR-0016) and a computed `is_minor` flag re-evaluated at login. If `date_of_birth` implies age < 16 at signup, the flow branches to a **guardian authorization** step: an email is sent (via Resend) to a guardian email address collected in the same form, containing a signed, time-limited link that must be clicked to activate the minor's account and record a `consent_records` row with `purpose = 'guardian_authorization'` and `source = 'guardian_email_link'`. Until that consent row exists, the account exists in `pending_guardian_approval` status and cannot log hours, appear on leaderboards, or post in community features.

## Consequences
### Positive
- Every consent, retention action, and privileged action is independently auditable and reconstructable without joining across schema boundaries in a fragile way — everything keys off ULIDs and timestamps.
- Anonymize-not-delete for hour entries means grant reporting integrity and GDPR erasure rights are both satisfied simultaneously — no forced choice between funder compliance and volunteer rights.
- Append-only consent and audit tables make "what did the user agree to and when" trivially answerable during a legal or funder audit, including historical policy-version tracking.
- Retention policies are data, not code — non-engineering compliance staff (with an admin role) can adjust retention windows without a deploy, though the *actions* (anonymize vs. hard-delete) remain engineer-defined per data class.

### Negative / Trade-offs
- The audit-log-via-outbox-drain path adds latency (seconds, bounded by graphile-worker poll interval) between a privileged action occurring and it appearing in `admin.audit_log`, versus a synchronous direct write. Accepted because it preserves the no-cross-schema-coupling architecture; mitigated by keeping the drain worker's poll interval low (5s) for audit-tagged events specifically.
- Anonymization is irreversible and must be implemented carefully per table — a bug that anonymizes the wrong `subject_id` scope is a data-loss-equivalent incident. Mitigated by requiring integration tests (ADR-0015) specifically for the DSAR erase job before it ships.
- `admin.audit_log` will grow unbounded (it is explicitly excluded from the retention sweep for the platform's own legal defensibility — audit logs proving *why* a moderation or approval decision was made are themselves the kind of record regulators expect to persist). This is accepted as a cost-of-doing-business storage growth, monitored and partitioned by month if it becomes a performance concern.
- Storing DOB is itself sensitive personal data requiring its own lawful basis (age-verification legitimate interest) and must be excluded from the general-purpose DSAR export's "share with anyone who has your login" surface — the export bundle should mask DOB to year-only unless the requester is the subject themselves authenticated, which the export job satisfies by design since it's subject-initiated.

## Alternatives Considered
- **Single boolean `terms_accepted` flag on `users`, no per-purpose consent table.** Rejected: fails GDPR's requirement for purpose-specific, granular, freely-given consent — a bundled "accept everything" checkbox is not valid consent for optional processing like leaderboard participation, and provides no historical record of *which* policy version was accepted, which is required to defend a consent claim if policy text changes later.
- **Hard-delete on erasure request (full cascading delete) with a separate nightly aggregate-snapshot table for grant reporting.** Rejected: doubles the data model (live tables + snapshot tables) for a benefit anonymization already provides directly, and risks the snapshot silently drifting from source-of-truth hour records between snapshot runs. Anonymize-in-place keeps one source of truth.
- **Third-party consent/DSAR management SaaS (e.g., Osano, OneTrust).** Rejected for v1: adds a paid vendor dependency and an external system that must stay in sync with in-house schema-per-context data, for a nonprofit with no monetization and a bounded compliance surface. The in-house design here is small enough (one table, two jobs) that the integration and ongoing-sync cost of a SaaS tool outweighs the build cost. Revisit only if DSAR volume or regulatory complexity grows materially (e.g., expansion into US state-level laws with divergent requirements).
- **Per-schema audit tables (e.g., `volunteering.audit_log`, `training.audit_log`) instead of one shared `admin.audit_log`.** Rejected: audit review is inherently a cross-cutting admin activity ("show me everything this staff member did this month") and per-schema tables would require a fan-out query across every schema's Prisma client to answer it. A single consumer-drained table, populated via each schema's own outbox, gets the cross-cutting view without cross-schema FKs.

## Implementation Notes
- `packages/audit/src/recordAuditEvent.ts` exports `recordAuditEvent(tx, { actorId, actorType, action, resourceType, resourceId, scopeType?, scopeId?, beforeState?, afterState?, metadata? })`, called inside the same Prisma `$transaction` as the privileged write, writing to that schema's `domain_events` table with `event_type = 'audit.recorded'` and `payload` containing the full audit shape plus `audit: true`.
- graphile-worker job names: `dsar_export_all`, `dsar_erase_subject`, `retention_sweep`, `audit_log_writer`. All registered in `apps/worker/src/jobs/index.ts` with explicit `queueName` per job to allow independent concurrency tuning (DSAR jobs run at concurrency 1 per subject to avoid racing export/erase on the same account; `audit_log_writer` runs at higher concurrency since it's idempotent per event ID).
- `dsar_export_all` and `dsar_erase_subject` are idempotent by `dsar_requests.id` — reprocessing a job with `status = 'completed'` is a no-op, guarding against graphile-worker's at-least-once delivery.
- Signed R2 URLs for DSAR export bundles use Cloudflare R2's presigned URL flow, 7-day TTL matching the `dsar_export_bundles` retention policy, and the R2 bucket has a lifecycle rule deleting objects after 7 days as a defense-in-depth backstop independent of the retention sweep job.
- Age-gating guardian email template lives in `packages/email-templates/guardian-authorization.tsx` (React Email, sent via Resend), with the signed link using a short-lived JWT (72-hour expiry) scoped to `purpose: 'guardian_authorization'` and the minor's `subject_id`, verified in `apps/web/app/api/v1/guardian-consent/[token]/route.ts`.
- Consent UI surfaces (settings page toggles) call a tRPC mutation `consent.update({ purpose, status })` which always inserts a new `consent_records` row — never updates — and returns the new current state for optimistic UI update.
