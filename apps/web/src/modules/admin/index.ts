/**
 * admin bounded-context module — public interface.
 *
 * Admin — platform-wide configuration, feature flags, retention policy, cross-context reporting.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 9 scope (docs/ddd/admin-reporting.md; docs/plans/implementation-plan.md's
 * "Phase 9 — Admin & Reporting"): the domain/application layer, plus (this
 * stage) the tRPC API layer under `api/trpc/router.ts`
 * (`server/api/routers/admin.ts` is the thin adapter that mounts it on the
 * root `appRouter`, same split every other module's own router follows).
 *
 * - `ReportDefinition`/`ExportJob` lifecycle (`CreateReportDefinition`,
 *   `UpdateReportDefinition`, `RequestExportJob`, `ProcessExportJob`,
 *   `GetExportDownloadUrl`, plus the read-side `listReportDefinitions`/
 *   `getReportDefinition`/`listExportJobs`/`getExportJob` this stage adds
 *   for the API Contract Sketch's own `reportDefinition.list`/`.get` and
 *   `exportJob.list`/`.get` procedures — no dedicated Key Use Case number,
 *   same "thin, `org_admin`-gated read" shape as the lifecycle use cases
 *   they sit beside) — including the SNAPSHOTTED-VALUATION-RATE invariant
 *   (`requestExportJob.ts`'s own doc comment carries the full explanation;
 *   this is the phase's one load-bearing invariant).
 * - `OrchestrateDsarRequest` + `consumeIdentityDsarEvents`: a COMMAND call
 *   to `identity.submitDsarRequest(...)` through `identity`'s own
 *   `index.ts` barrel only — this module never reads or writes
 *   `identity`'s tables directly — correlated back via `identity`'s own
 *   `DsarExportCompleted`/`DsarEraseCompleted` domain events.
 * - `SearchAuditLog`: dispatches to `admin.audit_log` and/or
 *   `moderation.queryModerationHistory` (via `moderation`'s own
 *   `index.ts`), UNIONED IN APPLICATION CODE — never a cross-schema SQL
 *   join. Hard architectural rule, see `searchAuditLog.ts`'s own doc
 *   comment.
 * - `runRetentionSweep` (ADR-0014 §3): identifies rows past their
 *   retention window per data class and invokes each owning schema's own
 *   cleanup function directly, through that schema's own `index.ts`
 *   barrel (`identity.sweepInactivePersons`,
 *   `identity.sweepExpiredDsarExportBundles`,
 *   `moderation.sweepModerationLogs`) — never a generic cross-schema
 *   `DELETE`/`UPDATE`. NOTE: this is the application-layer sweep logic
 *   only; wiring it into `apps/worker` as a live, scheduled
 *   graphile-worker task is deferred — that process has no dependency
 *   path to this module's (or any module's) Prisma-backed application
 *   layer yet (it only ever hand-writes raw `pg` SQL — see
 *   `apps/worker/src/tasks/audit-log-writer.ts`), the same
 *   infrastructure gap `identity.requestDataExport`/`requestErasure`
 *   already document for why THEIR async jobs also run synchronously
 *   in-process this far into the build instead of via a real
 *   graphile-worker task.
 * - `volunteering.queryApprovedHours` (Phase 3) is the source for
 *   grant-report hour data, called via `volunteering`'s own `index.ts`
 *   barrel (`processExportJob.ts`) — never a direct cross-schema query.
 */

// --- ReportDefinition / ExportJob lifecycle ---
export { createReportDefinition } from "./application/createReportDefinition";
export type { CreateReportDefinitionInput, CreatedReportDefinition } from "./application/createReportDefinition";

export { updateReportDefinition } from "./application/updateReportDefinition";
export type { UpdateReportDefinitionInput, UpdatedReportDefinition } from "./application/updateReportDefinition";

export { requestExportJob } from "./application/requestExportJob";
export type {
  GrantReportExportParams,
  RequestExportJobInput,
  RequestedExportJob,
} from "./application/requestExportJob";

export { processExportJob } from "./application/processExportJob";
export type { ProcessExportJobResult } from "./application/processExportJob";

export { getExportDownloadUrl } from "./application/getExportDownloadUrl";
export type { ExportDownloadUrl, GetExportDownloadUrlInput } from "./application/getExportDownloadUrl";

export { listReportDefinitions } from "./application/listReportDefinitions";
export type { ListReportDefinitionsInput, ReportDefinitionDto } from "./application/listReportDefinitions";

export { getReportDefinition } from "./application/getReportDefinition";
export type { GetReportDefinitionInput } from "./application/getReportDefinition";

export { listExportJobs } from "./application/listExportJobs";
export type { ExportJobDto, ExportJobPage, ListExportJobsFilters, ListExportJobsInput } from "./application/listExportJobs";

export { getExportJob } from "./application/getExportJob";
export type { GetExportJobInput } from "./application/getExportJob";

// --- DSAR orchestration (a command to identity, never direct data ownership — ADR-0014) ---
export { orchestrateDsarRequest } from "./application/orchestrateDsarRequest";
export type { OrchestrateDsarRequestInput, OrchestratedDsarRequest } from "./application/orchestrateDsarRequest";

export { consumeIdentityDsarEvents } from "./application/consumeIdentityDsarEvents";
export type { ConsumeEventResult, InboundIdentityEvent } from "./application/consumeIdentityDsarEvents";

// --- Cross-cutting audit search ---
export { searchAuditLog } from "./application/searchAuditLog";
export type {
  AuditLogQueryFilters,
  AuditLogSearchEntry,
  AuditLogSearchResult,
  AuditLogSearchSource,
} from "./application/searchAuditLog";

// --- Retention sweep (ADR-0014 §3) ---
export { runRetentionSweep } from "./application/runRetentionSweep";
export type { RetentionSweepDataClassResult, RetentionSweepResult } from "./application/runRetentionSweep";

// --- Report-type vocabulary (closed set) ---
export { SUPPORTED_REPORT_TYPES, isSupportedReportType } from "./domain/reportTypes";
export type { SupportedReportType } from "./domain/reportTypes";

// --- `ReportDefinition.filters` shape/resolution for `approved_hours_summary`
// (exported for the same reason every other module's own domain-layer pure
// functions are: unit-test coverage per ADR-0015's unit/integration split,
// through this module's own index.ts barrel like everything else here). ---
export { assertValidFiltersForReportType, resolveApprovedHoursDateWindow } from "./domain/reportFilters";
export type { ApprovedHoursSummaryFilters } from "./domain/reportFilters";

// --- R2 export-file storage adapter (ADR-0011) — exported for unit-test
// coverage of the real SigV4 signing logic, same precedent as
// `modules/training`/`modules/moderation`/`modules/community`'s own
// identically-shaped exports of their own `infra/cloudflareR2Client.ts`. ---
export { cloudflareR2Adapter, signS3PutRequest, presignS3GetUrl } from "./infra/cloudflareR2Client";
export type { ExportFileStorageAdapter, SignedS3PutRequest, PresignedGetUrl } from "./infra/cloudflareR2Client";

export {
  ExportJobDownloadExpiredError,
  ExportJobNotDownloadableError,
  ExportJobNotFoundError,
  ExternalServiceNotConfiguredError,
  ForbiddenActionError,
  InvalidExportJobStateError,
  ReportDefinitionNotActiveError,
  ReportDefinitionNotFoundError,
  UnsupportedReportTypeError,
} from "./domain/errors";
