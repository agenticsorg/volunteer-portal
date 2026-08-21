import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  OpportunityNotFoundError,
  OpportunityNotPublishedError,
  ShiftCapacityInvalidError,
  ShiftTimeOrderError,
} from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * ScheduleShift (docs/ddd/volunteering-opportunities.md, Key Use Case 2).
 *
 * *Pre:* Parent Opportunity is `published`; `endsAt > startsAt`; `capacity
 * >= 1`; caller holds the same chapter-scoped authority as
 * `PublishOpportunity` (the doc's own use-case text doesn't restate this,
 * but Shift has no independent ownership from its parent Opportunity — see
 * `shift.manage` in `packages/authz`).
 *
 * *Post:* New `Shift(status = 'scheduled', acceptedCount = 0)` row exists;
 * `ShiftScheduled` emitted.
 */
export interface ScheduleShiftInput {
  caller: PolicySubject;
  opportunityId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  capacity: number;
}

export interface ScheduledShift {
  shiftId: string;
}

export async function scheduleShift(prisma: PrismaClient, input: ScheduleShiftInput): Promise<ScheduledShift> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: { id: true, chapterId: true, status: true },
  });
  if (!opportunity) {
    throw new OpportunityNotFoundError(input.opportunityId);
  }

  await assertVolunteeringAuthority(prisma, input.caller, "shift.manage", "shift", opportunity.chapterId);

  if (opportunity.status !== "published") {
    throw new OpportunityNotPublishedError(opportunity.id);
  }
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new ShiftTimeOrderError();
  }
  if (input.capacity < 1) {
    throw new ShiftCapacityInvalidError();
  }

  const shiftId = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.shift.create({
      data: {
        id: shiftId,
        opportunityId: opportunity.id,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        capacity: input.capacity,
      },
      select: { id: true, opportunityId: true, startsAt: true, endsAt: true, capacity: true },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Shift",
        aggregateId: created.id,
        eventType: "ShiftScheduled",
        payload: {
          shiftId: created.id,
          opportunityId: created.opportunityId,
          startsAt: created.startsAt.toISOString(),
          endsAt: created.endsAt.toISOString(),
          capacity: created.capacity,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "shift.schedule",
      resourceType: "shift",
      resourceId: created.id,
      scopeType: opportunity.chapterId ? "chapter" : "global",
      scopeId: opportunity.chapterId ?? undefined,
      metadata: { opportunityId: opportunity.id },
    });
  });

  return { shiftId };
}
