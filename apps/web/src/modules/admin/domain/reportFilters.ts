import { UnsupportedReportTypeError } from "./errors";
import { isSupportedReportType, type SupportedReportType } from "./reportTypes";

/**
 * `ReportDefinition.filters` for `reportType = 'approved_hours_summary'`,
 * shaped to resolve directly into `volunteering.queryApprovedHours`'s own
 * `QueryApprovedHoursFilters` (Key Use Case 5: "calls the relevant owning
 * schema's read function(s) per `params.filters`"). Mirrors the Schema
 * Sketch's illustrative shape (`chapterIds?`, `dateRangeMode`) narrowed to
 * exactly what this phase's one wired report type needs — `programIds`/
 * `opportunityTypeIds` are the doc's own illustrative extras for report
 * types this phase does not implement.
 */
export interface ApprovedHoursSummaryFilters {
  chapterIds?: string[];
  opportunityIds?: string[];
  dateRangeMode: "fixed" | "relative";
  /** `dateRangeMode: 'fixed'` — ISO date, inclusive. */
  fromDate?: string;
  /** `dateRangeMode: 'fixed'` — ISO date, inclusive. */
  toDate?: string;
  /** `dateRangeMode: 'relative'` — trailing window ending "now", in days. */
  relativeDays?: number;
  // Index signature so this type-checks as a `filters: Record<string, unknown>`
  // JSONB payload at every call site (Prisma's `Json` columns are opaque,
  // untyped storage — this interface is this function's own narrowing of
  // that opaque shape for `reportType = 'approved_hours_summary'`, not a
  // DB-level schema for the column).
  [key: string]: unknown;
}

/**
 * `CreateReportDefinition`/`UpdateReportDefinition`'s own precondition
 * ("validates `filters`/`groupBy` against the known shape for
 * `reportType`") — a light, application-level structural check, not a
 * schema/DB-level one, matching `filters`' own `JSONB` column (Schema
 * Sketch: no DB-level shape enforcement for this deliberately
 * report-type-polymorphic column).
 */
export function assertValidFiltersForReportType(
  reportType: string,
  filters: Record<string, unknown>,
): asserts filters is ApprovedHoursSummaryFilters {
  if (!isSupportedReportType(reportType)) {
    throw new UnsupportedReportTypeError(reportType);
  }
  const reportTypeChecked: SupportedReportType = reportType;
  void reportTypeChecked; // exhaustiveness anchor — extend the switch below when a second report type is added.

  const mode = filters["dateRangeMode"];
  if (mode !== "fixed" && mode !== "relative") {
    throw new Error(
      `filters.dateRangeMode must be "fixed" or "relative" for reportType "${reportType}" (got ${JSON.stringify(mode)}).`,
    );
  }
  if (mode === "fixed") {
    if (typeof filters["fromDate"] !== "string" || typeof filters["toDate"] !== "string") {
      throw new Error('filters.fromDate/toDate (ISO date strings) are required when dateRangeMode is "fixed".');
    }
  } else if (typeof filters["relativeDays"] !== "number" || filters["relativeDays"] <= 0) {
    throw new Error('filters.relativeDays (a positive number) is required when dateRangeMode is "relative".');
  }
}

/**
 * Resolves `filters` (as stored on the `ReportDefinition`, `dateRangeMode`
 * possibly `'relative'`) into the concrete `fromDate`/`toDate` a run
 * actually executes against *right now* — the values `RequestExportJob`
 * snapshots into `ExportJob.params` (never re-resolved later, per the
 * snapshotted-valuation-rate invariant's sibling guarantee for the date
 * window itself: a `'relative'` definition's window is resolved once, at
 * request time, not re-evaluated if the same `ExportJob` were ever
 * inspected again).
 */
export function resolveApprovedHoursDateWindow(
  filters: ApprovedHoursSummaryFilters,
  now: Date,
): { fromDate: string; toDate: string } {
  if (filters.dateRangeMode === "fixed") {
    return { fromDate: filters.fromDate!, toDate: filters.toDate! };
  }
  const toDate = now;
  const fromDate = new Date(now.getTime() - filters.relativeDays! * 24 * 60 * 60 * 1000);
  return { fromDate: fromDate.toISOString(), toDate: toDate.toISOString() };
}
