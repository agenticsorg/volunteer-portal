import type { PrismaClient } from "@prisma/client";

/** `shifts.listByOpportunity`'s per-item shape (API Contract Sketch). */
export interface ShiftListItem {
  shiftId: string;
  opportunityId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity: number;
  acceptedCount: number;
  status: string;
}

/**
 * `shifts.listByOpportunity` (API Contract Sketch) — public read, same
 * visibility as `opportunities.list`/`getById` (a shift's schedule and
 * remaining capacity are exactly what a prospective applicant needs to see).
 */
export async function listShiftsByOpportunity(
  prisma: PrismaClient,
  opportunityId: string,
): Promise<ShiftListItem[]> {
  const shifts = await prisma.shift.findMany({
    where: { opportunityId },
    orderBy: { startsAt: "asc" },
  });

  return shifts.map((shift) => ({
    shiftId: shift.id,
    opportunityId: shift.opportunityId,
    startsAt: shift.startsAt.toISOString(),
    endsAt: shift.endsAt.toISOString(),
    timezone: shift.timezone,
    capacity: shift.capacity,
    acceptedCount: shift.acceptedCount,
    status: shift.status,
  }));
}
