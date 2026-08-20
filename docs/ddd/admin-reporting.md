# Admin & Reporting

## Purpose & Scope

The `admin` bounded context is where organizational staff turn raw operational data owned by *other* contexts into artifacts they can hand to a funder, a board, or a regulator: grant-ready hour reports, DSAR export bundles, and cross-cutting audit search. It is a reporting, orchestration, and job-lifecycle context — it does not own volunteers, hours, badges, courses, or moderation actions. It owns the *configuration* of how those things get reported (`ReportDefinition`), the *lifecycle* of a requested export (`ExportJob`), and a *read-only query capability* over another context's audit trail (`AuditLogQuery`).

Two things this context explicitly does **not** own, despite touching them operationally:
- **Data Subject Access Request (DSAR) machinery.** The actual export-all/erase-and-anonymize logic, the `identity.dsar_requests` table, and the two graphile-worker jobs that do the real work (`dsar_export_all`, `dsar_erase_subject`) belong to `identity`, per ADR-0014. `admin` gives an `org_admin` the operational surface to *trigger* that machinery on a subject's behalf (e.g. responding to a support ticket) and to *track* the resulting job as an `ExportJob`, but the command is sent to `identity`, not executed here.
- **The full, evidence-linked moderation history.** `moderation.report` and `moderation.moderation_action` (owned exclusively by the `moderation` context, see `moderation-trust-safety.md`) already *are* the detailed, evidence-linked system of record for a report or sanction — there is no separate `moderation.audit_log` table, by design: ADR-0014 §"Alternatives Considered" explicitly rejects per-schema audit tables in favor of one shared `admin.audit_log`. `admin` exposes a read-only, application-level query surface (`AuditLogQuery`) that lets an `org_admin` search both the shared platform-wide log and, when they need full detail, `moderation`'s own tables — without merging schemas or adding a cross-schema foreign key.

This context also owns `admin.retention_policies` and `admin.audit_log` (both established in ADR-0014, summarized here for completeness since they physically live in this schema) — the single, cross-cutting log of *privileged actions across the whole platform* (hour approvals, role grants, exports, and, via the outbox-drain `audit_log_writer` consumer, a summarized entry for every moderation action too). See Integration & Anti-Corruption Notes for how a summarized platform-wide entry relates to the fuller detail that stays in `moderation`'s own tables.

## Ubiquitous Language

| Term | Definition |
|---|---|
| ReportDefinition | A saved, reusable report configuration: what to report on, how to filter/group it, and what hourly rate to value volunteer time at. |
| ExportJob | A single requested, executed (or executing) export — one concrete run, optionally against a `ReportDefinition`, producing a downloadable file or a DSAR outcome. |
| Grant Report | An `ExportJob` of type `grant_report`: approved-hours rollup valued in dollars for funder/board packets. |
| DSAR Export/Erase | An `ExportJob` of type `dsar_export`, orchestrating `identity`'s subject-access or erasure workflow on an `org_admin`'s behalf. |
| Hourly Valuation Rate | A dollar-per-hour figure (default: the Independent Sector rate, $36.14/hr for 2026) used to convert approved volunteer hours into an in-kind dollar value for grant reporting. Configurable per `ReportDefinition`, snapshotted per `ExportJob` run. |
| AuditLogQuery | A read-only, application-level query interface admin uses to search the platform-wide `admin.audit_log` and, for full evidence-linked detail, `moderation`'s own report/action tables — not a table this schema owns, not a database join. |
| admin.audit_log | The single, platform-wide privileged-action audit trail (ADR-0014), fed by every schema's outbox including a summarized entry per moderation action. There is no separate `moderation.audit_log` — ADR-0014 explicitly rejects per-schema audit tables. |
| Retention Policy | A per-data-class rule (`admin.retention_policies`, ADR-0014) governing when and how (anonymize/hard-delete) stale data is swept from its owning schema. |
| Retention Sweep | The scheduled job that evaluates retention policies and triggers the owning schema's cleanup. |
| org_admin | The role authorized to configure reports, request exports, orchestrate DSAR requests, and search audit history. Scoped globally or per-chapter per the platform's RBAC model. |
| Output File Reference | The R2 object key + expiry backing a completed `ExportJob`'s downloadable artifact. |

## Aggregates, Entities & Value Objects

### `ReportDefinition` (aggregate root)
A saved configuration — "approved hours by chapter by quarter" — that can be re-run repeatedly with different date windows without re-specifying filters and grouping each time.

- `id` — ULID.
- `name`, `description`.
- `reportType` — application-level slug identifying the underlying query shape (e.g. `approved_hours_summary`).
- `filters` — JSON: `{ chapterIds?: string[], programIds?: string[], opportunityTypeIds?: string[], dateRangeMode: 'fixed' | 'relative', ... }`. Chapter/program IDs are `volunteering` IDs by reference only, never validated by FK.
- `groupBy` — ordered list of grouping dimensions, e.g. `['chapter', 'quarter']`.
- `hourlyValuationRateCents` — integer cents, default `3614` ($36.14, Independent Sector 2026 rate).
- `currency` — ISO 4217 code, default `USD`.
- `outputFormats` — subset of `{'csv','pdf'}` this definition supports generating.
- `isActive` — soft-disable without deleting a definition that's referenced by historical `ExportJob` rows.
- `createdByPersonId` — `identity.person.id`, by ID only.
- `createdAt`, `updatedAt`.

**Invariant:** `hourlyValuationRateCents` is never a global config value — it lives on the definition so different reports (e.g. a US-funder report vs. an EU-chapter report with a locally-appropriate rate) can use different rates simultaneously, and so a rate change never silently rewrites the meaning of a report someone is about to run.

### `ExportJob` (aggregate root)
One concrete, executed (or in-flight) export. Every `ExportJob` is immutable once `completed` or `failed` — a new run is a new `ExportJob`, never a re-opened one, so a funder-facing artifact can always be traced back to exactly the parameters that produced it.

- `id` — ULID.
- `type` — `grant_report` | `dsar_export` | `custom`.
- `status` — `queued` | `running` | `completed` | `failed`.
- `reportDefinitionId` — nullable FK (same schema) to `report_definition`; null for `dsar_export` and most `custom` jobs.
- `requestedByPersonId` — `identity.person.id`, by ID only — the `org_admin` who triggered it.
- `params` — JSON snapshot of the *concrete* values used for this run: resolved date range, chapter/program filters, and critically the `hourlyValuationRateCents` actually applied (copied from the `ReportDefinition` at request time, not read live at generation time — see invariant below). For `dsar_export`, `params.dsarOperation` is `'export' | 'erase'`, distinguishing the two DSAR workflow variants this job type covers.
- `identityDsarRequestId` — nullable, `identity.dsar_requests.id` by ID only, no FK. Set only when `type = 'dsar_export'`; correlates this job to the identity-owned request that is doing the actual work.
- `outputFileKey` — nullable R2 object key (e.g. `exports/grant-reports/{chapterId}/{exportId}.csv`), following the key convention established in ADR-0011.
- `outputFileFormat` — `csv` | `pdf` | `zip`, nullable (a `dsar_export` with `dsarOperation = 'erase'` produces no downloadable file — completion is a status change, not an artifact).
- `outputFileExpiresAt` — nullable; the download link's expiry, mirroring the R2 lifecycle rule for the relevant key prefix (7 days for `dsar_export`, 2 years for `grant_report`, per ADR-0011).
- `rowCount` — nullable, populated on completion for reports.
- `errorMessage` — nullable.
- `startedAt`, `completedAt`, `createdAt`.

**Invariants:**
1. **Valuation rate is snapshotted, not live.** `params.hourlyValuationRateCents` is fixed at `RequestExportJob` time. If an `org_admin` later edits the `ReportDefinition`'s rate, every previously-completed `ExportJob` remains reproducible and defensible under audit — the dollar figures in a downloaded grant packet never silently change meaning after the fact.
2. **A `dsar_export`-type `ExportJob` never touches `identity`'s or any other schema's person/consent tables directly.** It only ever calls `identity`'s published command interface and reacts to `identity`'s own outbox events. Admin **orchestrates**; it does not **own** the underlying data. See Integration & Anti-Corruption Notes.
3. **Terminal states are immutable.** Once `status` is `completed` or `failed`, no field may change except by a brand-new `ExportJob` row. Re-running a report is always a new job, never a resurrection of an old one, so `output_file_key` always corresponds to exactly the `params` that produced it.
4. **`output_file_key` is only ever accessed via a short-TTL signed URL**, never a public bucket path, per the presigned-URL pattern in ADR-0011 — this schema stores the key, never a public URL.

### `AuditLogQuery` (read-model / application service — not a persisted aggregate)
A stateless, read-only query capability, not a table. It has two independent read paths that a caller (the admin console) may use separately or together:
- **Platform-wide privileged-action search**, querying `admin.audit_log` directly (this schema's own table, established by ADR-0014) — normal in-schema SQL, no cross-context concern. This already includes a summarized entry for every moderation action, via the same outbox-drain mechanism every other schema uses.
- **Full moderation-history detail**, querying `moderation`'s own domain tables **through a read-only function moderation itself publishes** (`moderation.queryModerationHistory(filters)`, exported from `moderation`'s `index.ts` per the module-boundary convention in ADR-0001), returning `Report`/`ModerationAction` DTOs with the full evidence-linked detail those aggregates already carry — never a SQL join, never a materialized copy in `admin`'s schema, and never a query against a `moderation.audit_log` table, because no such table exists. See Integration & Anti-Corruption Notes for why this is safe and why it does not violate the no-cross-schema-FK rule.

Input shape (shared across both read paths, kept intentionally symmetric so the admin console UI can offer one search form):
```typescript
type AuditLogQueryFilters = {
  actorId?: string;
  actionPrefix?: string;      // e.g. 'moderation.' or 'hour.'
  resourceType?: string;
  resourceId?: string;
  occurredAfter?: Date;
  occurredBefore?: Date;
  scopeId?: string;            // chapter scoping
  cursor?: string;
  limit: number;                // max 200
};
```

### `RetentionPolicy` (entity, established by ADR-0014 — summarized for schema completeness)
Owned by `admin`, drives the `RetentionPolicyExpired` event this document adds to ADR-0014's design (see Domain Events). Full rationale and seed data live in ADR-0014 §3; only the columns relevant to this context's event-publishing responsibility are restated here: `dataClass`, `retentionDays`, `action` (`anonymize` | `hard_delete`), `enabled`.

## Domain Events

### Published (this context's own outbox: `admin.domain_events`)

| Event | Emitted When | Payload Highlights | Consumed By |
|---|---|---|---|
| `ExportJobQueued` | `RequestExportJob` creates an `export_job` row. | `exportJobId`, `type`, `requestedByPersonId` | (internal observability only) |
| `ExportJobCompleted` | `ProcessExportJob` (or the DSAR completion consumer) sets `status = 'completed'`. | `exportJobId`, `type`, `requestedByPersonId`, `outputFileKey?`, `outputFileExpiresAt?` | `notifications` (queues an `export_ready` notification to `requestedByPersonId`) |
| `ExportJobFailed` | `status = 'failed'`. | `exportJobId`, `type`, `requestedByPersonId`, `errorMessage` | `notifications` (optional failure alert, same mechanism) |
| `RetentionPolicyExpired` | The `retention_sweep` job (ADR-0014) identifies a batch of rows in a `dataClass` past `retentionDays`, in the same transaction it directly invokes the owning schema's sweep function. | `dataClass`, `cutoff`, `targetSchema`, `action`, `affectedCount` | Written as the durable audit/observability record of the sweep decision, and as a secondary trigger any schema may subscribe to independently of the direct invocation ADR-0014 already specifies — this event does not replace that direct call, it accompanies it. |

`admin` does not maintain a general-purpose external-event consumer (unlike `notifications`) — report and export *generation* reads other schemas' data **synchronously, at run time**, via each schema's own published read function (e.g. `volunteering.queryApprovedHours(filters)`, mirroring the exact fan-out pattern ADR-0014 already uses for `dsar_export_all`), rather than by continuously subscribing to every other schema's outbox. This is a deliberate choice: a report is a point-in-time query, not a running projection, so there is no benefit to keeping a live, eventually-consistent copy of `volunteering`'s hour data inside `admin`.

## Key Use Cases / Application Services

1. **`CreateReportDefinition({ name, reportType, filters, groupBy, hourlyValuationRateCents?, outputFormats })`** — validates `filters`/`groupBy` against the known shape for `reportType`, defaults `hourlyValuationRateCents` to `3614` if omitted, persists.
2. **`UpdateReportDefinition({ id, ...changes })`** — mutates a definition in place (definitions are living config, unlike jobs); does not retroactively affect any already-completed `ExportJob`.
3. **`RequestExportJob({ type, reportDefinitionId?, params, requestedByPersonId })`** — validates authorization (`can(subject, 'export:request', {type, scope})`), resolves and snapshots concrete `params` (including the valuation rate, if `reportDefinitionId` is set), inserts an `export_job` row with `status = 'queued'`, writes `ExportJobQueued`, and enqueues the `processExportJob` graphile-worker job (or, for `type = 'dsar_export'`, delegates to Use Case 4 instead of the generic processor).
4. **`OrchestrateDsarRequest({ subjectId, operation, requestedByPersonId })`** — the DSAR-specific path for `type = 'dsar_export'`. Calls `identity`'s published command `identity.submitDsarRequest({ subjectId, type: operation, requestedBy: { type: 'admin', id: requestedByPersonId } })` (an in-process call to `identity`'s public interface, per ADR-0001 — never a direct write into `identity`'s schema); stores the returned `identity.dsar_requests.id` as `identityDsarRequestId` on a new `export_job` row (`status = 'queued'`); a small dedicated consumer (`consumeIdentityDsarEvents`, structurally identical to the generic pattern documented in `notifications.md`) drains `identity.domain_events` for `DsarExportCompleted` / `DsarEraseCompleted`, and on receipt updates the correlated `export_job` — copying `identity.dsar_requests.result_url`'s R2 key into `outputFileKey`/`outputFileExpiresAt` for the export case, or simply marking `completed` with no file for the erase case — then writes this context's own `ExportJobCompleted`.
5. **`ProcessExportJob(exportJobId)`** *(graphile-worker job, `grant_report`/`custom` only)* — sets `status = 'running'`, `startedAt = now()`; calls the relevant owning schema's read function(s) per `params.filters` (e.g. `volunteering.queryApprovedHours`), computes valuation (`hours * hourlyValuationRateCents`), renders CSV and/or PDF, uploads to R2 under the `exports/grant-reports/{chapterId}/{exportId}.{ext}` key convention (ADR-0011), sets `rowCount`, `outputFileKey`, `outputFileFormat`, `outputFileExpiresAt` (now + 2 years per ADR-0011's lifecycle rule), `status = 'completed'`, `completedAt = now()`; writes `ExportJobCompleted`. On any failure, sets `status = 'failed'`, `errorMessage`, writes `ExportJobFailed` — the job is not retried automatically beyond graphile-worker's default retry policy, since a report generation failure usually needs a human look (bad filter combination, empty result set treated as an error vs. a valid zero-row report per `reportType` config).
6. **`SearchAuditLog(filters: AuditLogQueryFilters, { source: 'platform' | 'moderation_history' | 'both' })`** — dispatches to `admin.audit_log` and/or `moderation.queryModerationHistory(filters)` per `source`, returning a normalized, unioned-in-application-code (never in SQL) result set with a `source` tag per row so the UI can distinguish a summarized platform-level entry from the fuller moderation-owned detail.
7. **`GetExportDownloadUrl({ exportJobId, requestedByPersonId })`** — authorizes (`can(subject, 'export:download', exportJob)` — generally: the original requester or any `org_admin`), checks `status = 'completed'` and `outputFileExpiresAt > now()` (else `410 Gone`), mints a presigned R2 GET URL (15-minute TTL, per ADR-0011), never returns a raw bucket URL.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE admin.report_definition (
  id                           TEXT PRIMARY KEY,                 -- ULID
  name                         TEXT NOT NULL,
  description                  TEXT,
  report_type                  TEXT NOT NULL,                    -- app-level slug, e.g. 'approved_hours_summary'
  filters                      JSONB NOT NULL DEFAULT '{}',
  group_by                     TEXT[] NOT NULL DEFAULT '{}',      -- e.g. ARRAY['chapter','quarter']
  hourly_valuation_rate_cents  INT NOT NULL DEFAULT 3614,          -- Independent Sector 2026 default: $36.14/hr
  currency                     TEXT NOT NULL DEFAULT 'USD',
  output_formats                TEXT[] NOT NULL DEFAULT ARRAY['csv','pdf'],
  is_active                     BOOLEAN NOT NULL DEFAULT true,
  created_by_person_id          TEXT NOT NULL,                    -- identity.person.id, no FK
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX report_definition_active_idx
  ON admin.report_definition (is_active, created_at DESC);

CREATE TABLE admin.export_job (
  id                          TEXT PRIMARY KEY,                  -- ULID
  type                        TEXT NOT NULL
                                CHECK (type IN ('grant_report','dsar_export','custom')),
  status                      TEXT NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued','running','completed','failed')),
  report_definition_id        TEXT REFERENCES admin.report_definition(id),  -- null for dsar_export/custom
  requested_by_person_id      TEXT NOT NULL,                      -- identity.person.id, no FK
  params                      JSONB NOT NULL DEFAULT '{}',        -- snapshotted run params incl. valuation rate
  identity_dsar_request_id    TEXT,                                -- identity.dsar_requests.id, no FK
  output_file_key             TEXT,                                -- R2 key, ADR-0011 convention
  output_file_format          TEXT CHECK (output_file_format IN ('csv','pdf','zip')),
  output_file_expires_at      TIMESTAMPTZ,
  row_count                   INT,
  error_message                TEXT,
  started_at                   TIMESTAMPTZ,
  completed_at                  TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "List pending/running export jobs" — the graphile-worker drain/dispatch query.
CREATE INDEX export_job_active_idx
  ON admin.export_job (status, created_at)
  WHERE status IN ('queued','running');

-- "My export history" for the requesting admin.
CREATE INDEX export_job_requested_by_idx
  ON admin.export_job (requested_by_person_id, created_at DESC);

-- DSAR completion consumer correlation lookup.
CREATE INDEX export_job_dsar_request_idx
  ON admin.export_job (identity_dsar_request_id)
  WHERE identity_dsar_request_id IS NOT NULL;

-- Established by ADR-0014; restated here only for schema-completeness, not re-specified.
-- Full column set, seed data, and rationale: docs/adr/0014-data-privacy-and-compliance-architecture.md §3–4.
-- This is the ONLY audit-log table in the system — ADR-0014 explicitly rejects per-schema audit
-- tables (e.g. there is no moderation.audit_log). Full moderation detail lives in moderation's own
-- report/moderation_action tables and is reached via moderation.queryModerationHistory(), not a table here.
-- admin.retention_policies (data_class, retention_days, action, enabled, updated_at, updated_by)
-- admin.audit_log          (id, occurred_at, actor_id, actor_type, action, resource_type, resource_id,
--                            scope_type, scope_id, before_state, after_state, metadata, ip_address, request_id)

CREATE TABLE admin.domain_events (
  id            TEXT PRIMARY KEY,                                -- ULID
  aggregate_id  TEXT NOT NULL,                                    -- export_job.id, or a synthetic sweep-run id
  event_type    TEXT NOT NULL,                                    -- 'ExportJobQueued' | 'ExportJobCompleted' |
                                                                    -- 'ExportJobFailed' | 'RetentionPolicyExpired'
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX domain_events_unprocessed_idx
  ON admin.domain_events (id)
  WHERE processed_at IS NULL;
```

## API Contract Sketch

Per the canonical decision, admin's export endpoints are the concrete example of what belongs under the versioned public REST surface — a download link needs to be a stable, fetchable URL, not a tRPC call — while configuration and request-triggering stay on tRPC for the admin console itself.

```typescript
// apps/web/src/modules/admin/api/trpc/router.ts
export const adminReportingRouter = router({
  reportDefinition: router({
    create: orgAdminProcedure.input(createReportDefinitionInput).mutation(...),
    update: orgAdminProcedure.input(updateReportDefinitionInput).mutation(...),
    list: orgAdminProcedure.input(z.object({ activeOnly: z.boolean().default(true) })).query(...),
    get: orgAdminProcedure.input(z.object({ id: ulidSchema })).query(...),
  }),
  exportJob: router({
    request: orgAdminProcedure.input(requestExportJobInput).mutation(...),
    orchestrateDsar: orgAdminProcedure.input(orchestrateDsarInput).mutation(...),
    list: orgAdminProcedure.input(listExportJobsInput).query(...),
    get: orgAdminProcedure.input(z.object({ id: ulidSchema })).query(...),
  }),
  auditLog: router({
    search: orgAdminProcedure.input(auditLogQueryFiltersInput.extend({
      source: z.enum(['platform', 'moderation_history', 'both']).default('both'),
    })).query(...),
  }),
});
```

```typescript
// apps/web/app/api/v1/admin/exports/[exportJobId]/download/route.ts
// GET /api/v1/admin/exports/:exportJobId/download
// Authenticated + org_admin (or original requester) via can(); 410 if expired; otherwise a
// 302 redirect to a freshly-minted, 15-minute-TTL presigned R2 GET URL. Never returns the R2
// URL as JSON to avoid it being cached/logged somewhere with a longer effective lifetime.

// apps/web/app/api/v1/admin/exports/[exportJobId]/route.ts
// GET /api/v1/admin/exports/:exportJobId
// Returns { status, rowCount, outputFileFormat, outputFileExpiresAt } as JSON — a lightweight
// polling endpoint for the admin console while a long-running export is 'running', so the UI
// doesn't need a websocket for what is normally a sub-minute wait.
```

## Integration & Anti-Corruption Notes

**`AuditLogQuery` is a function call, not a join, and not a second copy of the data.** `admin` never creates a `moderation`-schema audit table of its own, never subscribes to `moderation`'s outbox to build a materialized read model of it, and never issues SQL that references both `admin.*` and `moderation.*` tables in one statement. Instead, `moderation` publishes a read-only query function on its module's public interface (`moderation.queryModerationHistory(filters): Promise<ModerationHistoryEntryDto[]>`, returning `Report`/`ModerationAction` detail), exactly the pattern ADR-0001 already establishes for synchronous cross-module reads needed within a single request (its own example: `identity.getPersonSummary(id)` used by `community` to render a feed author). `admin` calls that function in-process, in the same request that's serving the admin console's search UI, and returns the DTOs as-is or alongside a separate result set from its own `admin.audit_log` table — the "union," if the caller asked for `source: 'both'`, happens in TypeScript after both queries return, never in a shared SQL statement. This is why it does not violate the no-cross-schema-FK rule: there is no foreign key, no shared table, and no database-level coupling at all — only a typed function signature that `moderation` owns and can evolve (as long as it keeps the contract), the same discipline every other cross-module read in this system follows.

**There is one audit log, not two — `moderation` contributes to it, it doesn't duplicate it.** `admin.audit_log` (ADR-0014) is the single, platform-wide log of *privileged actions* — hour approvals, role grants, data exports, and, via the outbox-drain `audit_log_writer` consumer already specified in ADR-0014 (tagged `audit: true`), a summarized entry for every moderation action too. ADR-0014 §"Alternatives Considered" explicitly rejects maintaining a separate audit table per schema, precisely to avoid the fragmented-timeline problem two independent logs would create. What *does* stay exclusively in `moderation` is not a second audit log but the underlying domain detail — the full `Report` (evidence attachments per ADR-0011, reasoning, status history) and `ModerationAction` (enforcement-ladder step, duration, scope) rows — because that detail is `moderation`'s actual aggregate state, not an audit trail of it. `SearchAuditLog`'s `source` parameter lets an `org_admin` choose which view they need: `platform` for "show me everything privileged that happened this month across the whole system" (the summarized `admin.audit_log` entries), `moderation_history` for "show me the full moderation history on this user, with evidence" (calling into `moderation`'s own tables via `queryModerationHistory`), or `both` when they don't yet know which they need.

**DSAR orchestration is a command, not a data pipe.** `OrchestrateDsarRequest` never reads or writes `identity.person`, `identity.consent_record`, or `identity.dsar_requests` directly — it calls `identity.submitDsarRequest(...)`, a function `identity` exposes on its own `index.ts`, and afterward only ever reacts to `identity`'s own published outbox events (`DsarExportCompleted`/`DsarEraseCompleted`) to learn the outcome, using the exact same generic external-event-consumer mechanics documented in `notifications.md`'s Integration section (a graphile-worker job polling one schema's `domain_events` table, translating a known event type, never joining or reaching into any other table). This keeps `identity` the sole owner of DSAR correctness (the two-phase anonymize/hard-delete logic, the exceptions for grant-reporting aggregates, all specified in ADR-0014) while giving `admin` exactly the operational surface an `org_admin` needs: "trigger this on behalf of a person who filed a request through a channel other than self-service, and let me track it like any other export."

**Report generation is pull, not push, by design.** Because a `ReportDefinition` run is a point-in-time snapshot (a grant packet reflects "approved hours as of the day it was generated," not a live figure), `ProcessExportJob` calls each relevant schema's own published read function synchronously at generation time rather than maintaining a continuously-updated projection fed by that schema's outbox. This avoids the staleness/consistency questions a live projection would raise ("is this report's total as of right now, or as of the last event we happened to process?") and keeps `admin` from needing to know anything about `volunteering`'s or `training`'s internal event vocabulary at all — only their published query function's return shape, which is a much smaller, more stable surface than their full event stream.
