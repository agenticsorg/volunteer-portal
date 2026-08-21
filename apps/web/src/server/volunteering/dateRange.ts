/**
 * Shared date-only ("YYYY-MM-DD") → inclusive UTC range helpers for
 * `ExportApprovedHours` (Key Use Case 10)'s `fromDate`/`toDate` filters —
 * used by both `hourEntries.exportApproved` (tRPC) and
 * `GET /api/v1/hour-entries/export` (REST), so the two surfaces can never
 * disagree on what "inclusive" means for a date-only boundary.
 */
export function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function dayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}
