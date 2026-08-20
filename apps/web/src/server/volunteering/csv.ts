/**
 * CSV rendering for `ExportApprovedHours` (Key Use Case 10) — the
 * grant/board-ready extract of `volunteering.hour_entries` rows
 * `queryApprovedHours` returns. Shared by both export surfaces:
 * `hourEntries.exportApproved` (tRPC, writes this to disk via
 * `exportStorage.ts` and hands back a signed download URL) and
 * `GET /api/v1/hour-entries/export?format=csv` (REST, streams this
 * directly in the response body).
 *
 * Per the doc's own Integration & Anti-Corruption Notes ("grant export
 * never joins across schemas ... enriches rows with display names/chapter
 * names from a denormalized projection this context maintains locally"),
 * this phase has no such local projection built yet (no other bounded
 * context has a real event consumer either) — so rows are rendered with
 * raw `personId`/`chapterId`/`opportunityId` values, not display names.
 * Documented gap, not a silent one; a later Admin & Reporting phase is
 * expected to enrich this.
 */
import type { ApprovedHourEntryRecord } from "@/modules/volunteering";

const CSV_COLUMNS = [
  "hourEntryId",
  "personId",
  "opportunityId",
  "chapterId",
  "shiftId",
  "durationMinutes",
  "hours",
  "description",
  "approverPersonId",
  "approvedAt",
] as const;

/** RFC 4180 field quoting: quote and double-up embedded quotes whenever a field contains a comma, quote, or newline. */
function csvField(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function toRow(record: ApprovedHourEntryRecord): string {
  const hours = Math.round((record.durationMinutes / 60) * 100) / 100;
  return [
    record.hourEntryId,
    record.personId,
    record.opportunityId,
    record.chapterId,
    record.shiftId,
    record.durationMinutes,
    hours,
    record.description,
    record.approverPersonId,
    record.approvedAt,
  ]
    .map(csvField)
    .join(",");
}

/** Builds the full CSV document (header + one row per approved hour entry), CRLF line endings per RFC 4180. */
export function buildApprovedHoursCsv(records: readonly ApprovedHourEntryRecord[]): string {
  const lines = [CSV_COLUMNS.join(","), ...records.map(toRow)];
  return lines.join("\r\n") + "\r\n";
}
