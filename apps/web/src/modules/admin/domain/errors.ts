/**
 * Domain errors for the `admin` bounded context (docs/ddd/admin-reporting.md).
 * Thrown by the use cases under `application/`; caught at the (future) tRPC
 * procedure boundary and translated to the appropriate `TRPCError` code
 * there — this module itself has no knowledge of tRPC, same split as every
 * other module's `domain/errors.ts`.
 */

/**
 * A `can()` (ADR-0007) check denied the caller's requested action —
 * `report_definition.manage`, `export.request`, `export.download`,
 * `dsar.orchestrate`, or `audit_log.search`.
 */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/** No `admin.report_definition` row exists for the given id. */
export class ReportDefinitionNotFoundError extends Error {
  constructor(reportDefinitionId: string) {
    super(`No report definition found for id "${reportDefinitionId}".`);
    this.name = "ReportDefinitionNotFoundError";
  }
}

/** No `admin.export_job` row exists for the given id. */
export class ExportJobNotFoundError extends Error {
  constructor(exportJobId: string) {
    super(`No export job found for id "${exportJobId}".`);
    this.name = "ExportJobNotFoundError";
  }
}

/**
 * `RequestExportJob`'s `reportDefinitionId` (required for `type =
 * 'grant_report'`) does not resolve, or resolves to a `ReportDefinition`
 * with `isActive = false` — a disabled definition may still be referenced
 * by historical `ExportJob` rows (Schema Sketch), but must not be used to
 * start a new run.
 */
export class ReportDefinitionNotActiveError extends Error {
  constructor(reportDefinitionId: string) {
    super(`Report definition "${reportDefinitionId}" is not active.`);
    this.name = "ReportDefinitionNotActiveError";
  }
}

/**
 * `ExportJob` invariant 3 ("terminal states are immutable ... a new run is
 * always a new job, never a resurrection of an old one"): `ProcessExportJob`
 * or the DSAR completion consumer were asked to advance a job that is
 * already `completed`/`failed`, or `RequestExportJob`'s own `type`/params
 * validation rejected the request before any row was created.
 */
export class InvalidExportJobStateError extends Error {
  constructor(exportJobId: string, currentStatus: string, attemptedAction: string) {
    super(`Export job "${exportJobId}" is "${currentStatus}"; cannot "${attemptedAction}".`);
    this.name = "InvalidExportJobStateError";
  }
}

/** `admin.report_definition.report_type` does not match a known, generatable report shape. */
export class UnsupportedReportTypeError extends Error {
  constructor(reportType: string) {
    super(`No report generator is registered for reportType "${reportType}".`);
    this.name = "UnsupportedReportTypeError";
  }
}

/**
 * `GetExportDownloadUrl` (Key Use Case 7): the job is not `status =
 * 'completed'`, or has no `outputFileKey` at all (a `dsar_export` with
 * `dsarOperation = 'erase'` — "completion is a status change, not an
 * artifact").
 */
export class ExportJobNotDownloadableError extends Error {
  constructor(exportJobId: string) {
    super(`Export job "${exportJobId}" has no downloadable output.`);
    this.name = "ExportJobNotDownloadableError";
  }
}

/**
 * `GetExportDownloadUrl`: `outputFileExpiresAt <= now()` — the doc's own
 * "checks ... else `410 Gone`" precondition.
 */
export class ExportJobDownloadExpiredError extends Error {
  constructor(exportJobId: string) {
    super(`Export job "${exportJobId}"'s download link has expired.`);
    this.name = "ExportJobDownloadExpiredError";
  }
}

/**
 * An R2-backed adapter call (ADR-0011) requires an environment variable
 * that is not set in this environment. Thrown instead of faking success —
 * see `infra/cloudflareR2Client.ts`'s own header comment.
 */
export class ExternalServiceNotConfiguredError extends Error {
  constructor(missingEnvVar: string, purpose: string) {
    super(`${purpose} requires the "${missingEnvVar}" environment variable, which is not set.`);
    this.name = "ExternalServiceNotConfiguredError";
  }
}
