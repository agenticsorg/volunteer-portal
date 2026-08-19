# ADR 0005: Schema Additions — AuditLog Table and Co-Lead Support

## Status

Accepted — 2026-08-19

## Context

`concept.md` states "four objects carry the entire system" (Volunteer,
Project, Assignment, HourEntry), but its own section 9 requires "audit log
on all admin actions and hour adjustments." `research-findings.md`
confirms this as a contradiction: the schema is five tables minimum once
the compliance floor is accounted for.

Separately, the current model has `Project.lead` as a single foreign key.
`research-findings.md` flags that if the Agentics Foundation ever wants
co-leads on a project (shared leadership, distributed hour-approval
authority), this needs a join table — cheap to add now, before production
data exists, expensive to retrofit after.

## Decision

**Add `audit_log` as a fifth core table**, minimum columns:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `actor_id` | uuid, FK → `volunteer.id` | the admin/lead making the change |
| `action` | text (enum-checked) | e.g. `created`, `updated`, `deleted`, `hour_approved`, `hour_rejected`, `hour_adjusted`, `role_changed` |
| `entity_type` | text (enum-checked) | `volunteer`, `project`, `assignment`, `hour_entry` |
| `entity_id` | uuid | PK of the affected entity |
| `before` | jsonb, nullable | snapshot of old values (null on create) |
| `after` | jsonb, nullable | snapshot of new values (null on delete) |
| `created_at` | timestamptz | UTC, server-assigned |

This is wired at the **framework level**, not per-handler: the scoped-
transaction helper from [[0004-orm-and-row-level-security]] is extended so
that any handler using the mutating-auth extractors from
[[0002-backend-web-framework]] on `volunteer`, `project`, `assignment`, or
`hour_entry` writes an `audit_log` row as part of the same transaction, by
construction. Per build-roadmap.md's Phase 1 exit criteria, "AuditLog
writes are wired at the framework level so every subsequent phase's
mutations land there by construction, not by each phase remembering to
call it" — this ADR is what makes that criterion satisfiable.

**Add `project_lead` as a sixth table** now, at Phase 1, rather than
deferring:

| Column | Type | Notes |
|---|---|---|
| `project_id` | uuid, FK → `project.id` | |
| `volunteer_id` | uuid, FK → `volunteer.id` | |
| `role` | text, default `'lead'` | reserved for future differentiation, e.g. `'co-lead'` |

Primary key on `(project_id, volunteer_id)`. `Project.lead_id` is removed
in favor of this join table from the start — there is no single-FK
interim state to migrate away from later. Lead-scoping authorization
(Phase 3/4) checks membership in `project_lead`, not equality against a
single FK.

**Rationale for deciding co-leads now rather than deferring:** the
research pass explicitly frames this as "cheap now, expensive to retrofit
once production data exists" — a single-FK-to-join-table migration after
launch requires a data migration, a window of dual-write or downtime, and
rewriting every lead-scoping query and its RLS policy simultaneously. The
schema cost of the join table at Phase 1 is one extra table and a
marginally more complex authorization query (`EXISTS` against
`project_lead` instead of `= project.lead_id`) — small relative to the
retrofit cost.

## Consequences

**Positive:**
- Closes the compliance contradiction identified in research-findings.md:
  the schema now actually satisfies concept.md section 9's audit
  requirement.
- Framework-level audit writes mean no future phase can ship a mutation
  path that silently skips auditing — it is enforced by the
  scoped-transaction helper, not by developer discipline.
- Co-lead support from day one avoids a high-risk, high-effort schema
  migration under production data later, and costs almost nothing now.

**Negative / accepted risk:**
- `before`/`after` jsonb snapshots grow the audit_log table without
  bound over time; no retention/archival policy is specified in this
  ADR — deferred to [[0015-pipeda-breach-notification-and-privacy-officer]]
  and the Phase 10 compliance-hardening pass, which owns data-retention
  policy generally.
- RLS policies on `project`/`hour_entry` become marginally more complex
  (an `EXISTS` subquery against `project_lead` rather than a direct
  column comparison), a small but real query-performance and
  review-complexity cost paid starting at Phase 1 rather than only if
  co-leads are actually used.
- The audit log itself is a mutation target with no additional
  protection specified here beyond standard RLS (only accessible via
  admin-scoped queries) — it is not tamper-evident (no hash chaining or
  append-only enforcement at the database level). Flagged as an
  acceptable v1 gap; revisit if compliance requirements tighten.

## Alternatives Considered

- **Defer co-leads, keep `Project.lead_id` single FK.** Rejected per the
  research pass's explicit cost asymmetry (cheap now vs. expensive
  retrofit). Single-lead-per-project is not stated as a permanent
  business rule anywhere in concept.md, so there is no strong reason to
  bet against ever needing it.
- **Audit log as an append-only external system (e.g. separate logging
  service) instead of a Postgres table.** Rejected for v1 — adds an
  operational dependency and cross-system consistency risk
  (transactional audit writes are only guaranteed atomic with the
  mutation if they're in the same database transaction) for a benefit
  (tamper-evidence) not required by PIPEDA/GDPR at this stage.

## Phase Gate

Unblocks Phase 1 (Foundation) — schema must include both tables before
scaffold is considered complete. Unblocks Phase 3 (lead-scoped
authorization queries against `project_lead`) and Phase 8 (audit-log
coverage testing on every admin mutation path).
