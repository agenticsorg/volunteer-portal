import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { ShiftAlreadyDecidedError, ShiftHasApprovedHoursError, ShiftNotFoundError } from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

const NON_TERMINAL_APPLICATION_STATUSES = ["pending", "accepted", "waitlisted"] as const;

/**
 * CancelShift (docs/ddd/volunteering-opportunities.md, Key Use Case 3).
 *
 * *Pre:* No `HourEntry` referencing this shift is `approved` (Shift
 * invariant 4); shift is currently `scheduled`; caller holds the same
 * chapter-scoped authority as `ScheduleShift`.
 *
 * *Post:* `status = 'cancelled'` (`acceptedCount` reset to 0 — the shift is
 * no longer accepting anyone); every non-terminal (`pending`/`accepted`/
 * `waitlisted`) Application on this shift transitions to `declined` with an
 * auto-generated `decisionNote`, each emitting its own `ApplicationDeclined`;
 * `ShiftCancelled` emitted.
 *
 * The "no approved HourEntry" pre-check runs before the transaction opens —
 * same best-effort, not-fully-race-proof shape as this codebase's other
 * pre-checks (e.g. `createChapter`'s slug-uniqueness check backed by a real
 * DB unique constraint) rather than a `SELECT ... FOR UPDATE` lock; a
 * concurrent `ApproveHours` racing this exact call is an accepted,
 * documented gap, not a silent one.
 */
export interface CancelShiftInput {
  caller: PolicySubject;
  shiftId: string;
  reason: string;
}

export async function cancelShift(prisma: PrismaClient, input: CancelShiftInput): Promise<void> {
  const shift = await prisma.shift.findUnique({
    where: { id: input.shiftId },
    select: { id: true, opportunityId: true, status: true, opportunity: { select: { chapterId: true } } },
  });
  if (!shift) {
    throw new ShiftNotFoundError(input.shiftId);
  }

  await assertVolunteeringAuthority(prisma, input.caller, "shift.manage", "shift", shift.opportunity.chapterId);

  if (shift.status !== "scheduled") {
    throw new ShiftAlreadyDecidedError(shift.id, shift.status);
  }

  const approvedHourEntryCount = await prisma.hourEntry.count({
    where: { shiftId: shift.id, status: "approved" },
  });
  if (approvedHourEntryCount > 0) {
    throw new ShiftHasApprovedHoursError(shift.id);
  }

  const decisionNote = `Shift cancelled: ${input.reason}`;
  const decidedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const affectedApplications = await tx.application.findMany({
      where: { shiftId: shift.id, status: { in: [...NON_TERMINAL_APPLICATION_STATUSES] } },
      select: { id: true, applicantPersonId: true },
    });

    await tx.shift.update({
      where: { id: shift.id, status: "scheduled" },
      data: { status: "cancelled", acceptedCount: 0 },
    });

    for (const application of affectedApplications) {
      await tx.application.update({
        where: { id: application.id },
        data: {
          status: "declined",
          decidedByPersonId: input.caller.id,
          decidedAt,
          decisionNote,
        },
      });

      await tx.volunteeringDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "Application",
          aggregateId: application.id,
          eventType: "ApplicationDeclined",
          payload: {
            applicationId: application.id,
            shiftId: shift.id,
            applicantPersonId: application.applicantPersonId,
            decidedAt: decidedAt.toISOString(),
            decisionNote,
          } satisfies Prisma.InputJsonValue,
        },
      });
    }

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Shift",
        aggregateId: shift.id,
        eventType: "ShiftCancelled",
        payload: {
          shiftId: shift.id,
          opportunityId: shift.opportunityId,
          cancelledAt: decidedAt.toISOString(),
          reason: input.reason,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "shift.cancel",
      resourceType: "shift",
      resourceId: shift.id,
      scopeType: shift.opportunity.chapterId ? "chapter" : "global",
      scopeId: shift.opportunity.chapterId ?? undefined,
      metadata: { reason: input.reason, declinedApplicationCount: affectedApplications.length },
    });
  });
}
