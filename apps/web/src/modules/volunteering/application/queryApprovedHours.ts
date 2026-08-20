import type { PrismaClient } from "@prisma/client";

/**
 * One approved `HourEntry`, as `queryApprovedHours` hands it back — the raw
 * shape `ExportApprovedHours` (Key Use Case 10) and, in a much later
 * Admin & Reporting phase, grant-report generation build on top of.
 *
 * Deliberately **not** enriched with display names/chapter names here: the
 * doc's own Integration & Anti-Corruption Notes are explicit that "grant
 * export never joins across schemas" and that enrichment happens "from a
 * denormalized projection this context maintains locally, kept current by
 * consuming identity's `PersonRegistered`/`ChapterCreated`/
 * `PersonAnonymized` events" — a local event-consumer/read-model this phase
 * does not build (no other bounded context has a real event consumer yet
 * either). `chapterId` below comes from `Opportunity.chapterId` via a
 * same-schema (same bounded context) relation, which is not the
 * cross-schema join the doc warns against — `Opportunity` and `HourEntry`
 * both live in `volunteering`.
 */
export interface ApprovedHourEntryRecord {
  hourEntryId: string;
  personId: string;
  opportunityId: string;
  chapterId: string | null;
  shiftId: string | null;
  durationMinutes: number;
  description: string | null;
  approverPersonId: string;
  approvedAt: string;
}

export interface QueryApprovedHoursFilters {
  chapterId?: string;
  opportunityId?: string;
  /** Inclusive lower bound on `approvedAt`. */
  fromDate: Date;
  /** Inclusive upper bound on `approvedAt`. */
  toDate: Date;
}

/**
 * `volunteering.queryApprovedHours(filters)` — the read function Key Use
 * Case 10 (`ExportApprovedHours`) and a much later Admin & Reporting phase
 * both depend on. Built now, per the Phase 3 implementation prompt, "even
 * though nothing calls it yet." Deliberately carries no `can()` gate itself
 * — same shape as this module's other plain read functions (`listChapters`
 * in `identity` has none either) — because a raw grant-hours extract is
 * exactly the kind of read whose authorization (`org_admin`, or
 * `chapter_lead` scoped to `filters.chapterId` — Key Use Case 10's
 * precondition) belongs at the calling procedure/router layer, once one
 * exists to call it from; this function only ever answers "what does the
 * filtered data say," not "is this caller allowed to ask."
 *
 * Uses `idx_hour_entries_approved_export` (the partial index on
 * `approved_at WHERE status = 'approved'`) via the `status: 'approved'` +
 * `approvedAt` range filter below.
 */
export async function queryApprovedHours(
  prisma: PrismaClient,
  filters: QueryApprovedHoursFilters,
): Promise<ApprovedHourEntryRecord[]> {
  const entries = await prisma.hourEntry.findMany({
    where: {
      status: "approved",
      approvedAt: { gte: filters.fromDate, lte: filters.toDate },
      opportunityId: filters.opportunityId,
      opportunity: filters.chapterId ? { chapterId: filters.chapterId } : undefined,
    },
    select: {
      id: true,
      personId: true,
      opportunityId: true,
      shiftId: true,
      durationMinutes: true,
      description: true,
      approverPersonId: true,
      approvedAt: true,
      opportunity: { select: { chapterId: true } },
    },
    orderBy: { approvedAt: "asc" },
  });

  return entries.map((entry) => ({
    hourEntryId: entry.id,
    personId: entry.personId,
    opportunityId: entry.opportunityId,
    chapterId: entry.opportunity.chapterId,
    shiftId: entry.shiftId,
    durationMinutes: entry.durationMinutes,
    description: entry.description,
    // Non-null by `chk_hour_entries_approval`: every `status = 'approved'`
    // row has a non-null `approverPersonId`/`approvedAt`.
    approverPersonId: entry.approverPersonId!,
    approvedAt: entry.approvedAt!.toISOString(),
  }));
}
