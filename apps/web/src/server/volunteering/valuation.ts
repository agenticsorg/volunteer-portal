/**
 * Grant-report valuation for `hourEntries.exportApproved` / `GET
 * /api/v1/hour-entries/export` (Key Use Case 10, `ExportApprovedHours`):
 * "valued at a configurable hourly rate."
 *
 * The API Contract Sketch's `hourlyRate` input is optional, so this
 * deliberately does not hard-code a specific published rate (e.g. an
 * Independent Sector volunteer-hour figure) — that number changes yearly
 * and is a board/funder policy choice, not something this codebase should
 * assert as a compile-time constant. When no `hourlyRate` is supplied,
 * `totalValue` is `0` (a caller who wants a dollar figure must say what an
 * hour is worth); `totalHours` is always computed regardless.
 */
import type { ApprovedHourEntryRecord } from "@/modules/volunteering";

export interface ApprovedHoursSummary {
  totalHours: number;
  totalValue: number;
}

const MINUTES_PER_HOUR = 60;

/** Rounds to 2 decimal places — hours/dollars, not raw floating point. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeApprovedHours(
  records: readonly ApprovedHourEntryRecord[],
  hourlyRate?: number,
): ApprovedHoursSummary {
  const totalMinutes = records.reduce((sum, record) => sum + record.durationMinutes, 0);
  const totalHours = round2(totalMinutes / MINUTES_PER_HOUR);
  const totalValue = hourlyRate ? round2(totalHours * hourlyRate) : 0;
  return { totalHours, totalValue };
}
