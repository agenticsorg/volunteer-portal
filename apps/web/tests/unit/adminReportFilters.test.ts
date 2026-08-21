import { describe, expect, it } from "vitest";
import { assertValidFiltersForReportType, resolveApprovedHoursDateWindow } from "@/modules/admin";

// Pure-function coverage for `ReportDefinition.filters`' own structural
// validation and date-window resolution (docs/ddd/admin-reporting.md, Key
// Use Cases 1/2's own "validates `filters`/`groupBy` against the known
// shape for `reportType`" precondition, and `requestExportJob.ts`'s own
// "resolves ... concrete `params`" step) — no database, per ADR-0015's
// unit/integration split, same split `moderationActionRules.test.ts`
// establishes for its own sibling module's domain layer.
describe("assertValidFiltersForReportType", () => {
  it("rejects an unsupported reportType before looking at filters at all", () => {
    expect(() =>
      assertValidFiltersForReportType("not_a_real_report_type", { dateRangeMode: "fixed" }),
    ).toThrow(/No report generator is registered for reportType/);
  });

  it("rejects a dateRangeMode that is neither 'fixed' nor 'relative'", () => {
    expect(() =>
      assertValidFiltersForReportType("approved_hours_summary", { dateRangeMode: "whenever" }),
    ).toThrow(/dateRangeMode must be "fixed" or "relative"/);
  });

  it("requires fromDate/toDate strings when dateRangeMode is 'fixed'", () => {
    expect(() =>
      assertValidFiltersForReportType("approved_hours_summary", { dateRangeMode: "fixed" }),
    ).toThrow(/fromDate\/toDate/);
    expect(() =>
      assertValidFiltersForReportType("approved_hours_summary", {
        dateRangeMode: "fixed",
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
      }),
    ).not.toThrow();
  });

  it("requires a positive relativeDays when dateRangeMode is 'relative'", () => {
    expect(() =>
      assertValidFiltersForReportType("approved_hours_summary", { dateRangeMode: "relative" }),
    ).toThrow(/relativeDays/);
    expect(() =>
      assertValidFiltersForReportType("approved_hours_summary", { dateRangeMode: "relative", relativeDays: 0 }),
    ).toThrow(/relativeDays/);
    expect(() =>
      assertValidFiltersForReportType("approved_hours_summary", { dateRangeMode: "relative", relativeDays: 30 }),
    ).not.toThrow();
  });
});

describe("resolveApprovedHoursDateWindow", () => {
  it("passes a 'fixed' window's fromDate/toDate through unchanged, ignoring `now`", () => {
    const window = resolveApprovedHoursDateWindow(
      { dateRangeMode: "fixed", fromDate: "2026-01-01", toDate: "2026-01-31" },
      new Date("2030-06-15T00:00:00.000Z"),
    );
    expect(window).toEqual({ fromDate: "2026-01-01", toDate: "2026-01-31" });
  });

  it("resolves a 'relative' window to a trailing N-day range ending at `now`", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const window = resolveApprovedHoursDateWindow({ dateRangeMode: "relative", relativeDays: 7 }, now);

    expect(window.toDate).toBe(now.toISOString());
    expect(window.fromDate).toBe(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
});
