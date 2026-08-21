/**
 * The closed set of `report_type` slugs this phase actually knows how to
 * generate (docs/ddd/admin-reporting.md's `ReportDefinition.reportType`:
 * "application-level slug identifying the underlying query shape"). Kept
 * as an application-enforced list, not a DB enum or CHECK constraint —
 * same convention `report_definition.report_type`'s own Schema Sketch
 * comment already establishes ("an application-enforced closed set that
 * avoids a migration every time a new job type/status is added").
 *
 * `approved_hours_summary` is the only shape wired up this phase: it's the
 * one Key Use Case 5 (`ProcessExportJob`) actually describes ("calls the
 * relevant owning schema's read function(s) per `params.filters` (e.g.
 * `volunteering.queryApprovedHours`)"), and `volunteering.queryApprovedHours`
 * (Phase 3) is the only cross-context grant-reporting read this codebase
 * has built so far — the same "one report type this phase" scope
 * `queryApprovedHours`'s and `queryModerationHistory`'s own doc comments
 * already establish for their respective callers.
 */
export const SUPPORTED_REPORT_TYPES = ["approved_hours_summary"] as const;

export type SupportedReportType = (typeof SUPPORTED_REPORT_TYPES)[number];

export function isSupportedReportType(value: string): value is SupportedReportType {
  return (SUPPORTED_REPORT_TYPES as readonly string[]).includes(value);
}
