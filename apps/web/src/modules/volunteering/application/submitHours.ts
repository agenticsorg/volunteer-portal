import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { getPersonSummary } from "@/modules/identity";
import {
  HourEntryDurationInvalidError,
  HourEntryOutsideShiftWindowError,
  HourEntryTimeOrderError,
  OpportunityNotFoundError,
  PersonNotFoundError,
  ShiftNotFoundError,
} from "../domain/errors";

const MINUTE_MS = 60_000;
const MAX_DURATION_MINUTES = 1440;

/**
 * HourEntry invariant 5's "reasonable early-arrival/overrun tolerance
 * configured at the application layer" — 2 hours either side of the
 * referenced Shift's scheduled window. Not derived from anywhere in the
 * doc's own text (it explicitly leaves the exact tolerance to this layer);
 * chosen as a generous-but-bounded default that catches obvious
 * mis-submissions (logging hours for the wrong shift entirely) without
 * penalizing normal early-arrival/overrun.
 */
const SHIFT_WINDOW_TOLERANCE_MINUTES = 120;

/**
 * SubmitHours (docs/ddd/volunteering-opportunities.md, Key Use Case 7).
 * Self-service — the person logging hours is always the caller (the
 * contract sketch: "caller = personId, taken from session"), so this takes
 * no separate `callerId`/`personId` pair to authorize against.
 *
 * *Pre:* `endAt > startAt`; `durationMinutes <= 1440`; if `shiftId` is
 * given, it must belong to `opportunityId` and `startAt`/`endAt` must fall
 * within `SHIFT_WINDOW_TOLERANCE_MINUTES` of that Shift's `startsAt`/
 * `endsAt` (invariant 5).
 *
 * *Post:* New `HourEntry(status = 'submitted')` row exists;
 * `HoursSubmitted` emitted.
 */
export interface SubmitHoursInput {
  personId: string;
  opportunityId: string;
  shiftId: string | null;
  startAt: Date;
  endAt: Date;
  description: string | null;
}

export interface SubmittedHourEntry {
  hourEntryId: string;
}

export async function submitHours(prisma: PrismaClient, input: SubmitHoursInput): Promise<SubmittedHourEntry> {
  const person = await getPersonSummary(prisma, input.personId);
  if (!person) {
    throw new PersonNotFoundError(input.personId);
  }

  const opportunity = await prisma.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: { id: true },
  });
  if (!opportunity) {
    throw new OpportunityNotFoundError(input.opportunityId);
  }

  if (input.endAt.getTime() <= input.startAt.getTime()) {
    throw new HourEntryTimeOrderError();
  }
  const durationMinutes = Math.round((input.endAt.getTime() - input.startAt.getTime()) / MINUTE_MS);
  if (durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
    throw new HourEntryDurationInvalidError();
  }

  if (input.shiftId !== null) {
    const shift = await prisma.shift.findUnique({
      where: { id: input.shiftId, opportunityId: input.opportunityId },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (!shift) {
      throw new ShiftNotFoundError(input.shiftId);
    }
    const toleranceMs = SHIFT_WINDOW_TOLERANCE_MINUTES * MINUTE_MS;
    const earliestAllowed = shift.startsAt.getTime() - toleranceMs;
    const latestAllowed = shift.endsAt.getTime() + toleranceMs;
    if (input.startAt.getTime() < earliestAllowed || input.endAt.getTime() > latestAllowed) {
      throw new HourEntryOutsideShiftWindowError(shift.id);
    }
  }

  const hourEntryId = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.hourEntry.create({
      data: {
        id: hourEntryId,
        personId: input.personId,
        opportunityId: input.opportunityId,
        shiftId: input.shiftId,
        startAt: input.startAt,
        endAt: input.endAt,
        durationMinutes,
        description: input.description,
      },
      select: { id: true, personId: true, opportunityId: true, shiftId: true, durationMinutes: true, submittedAt: true },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "HourEntry",
        aggregateId: created.id,
        eventType: "HoursSubmitted",
        payload: {
          hourEntryId: created.id,
          personId: created.personId,
          opportunityId: created.opportunityId,
          shiftId: created.shiftId,
          durationMinutes: created.durationMinutes,
          submittedAt: created.submittedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.personId,
      actorType: "user",
      action: "hour_entry.submit",
      resourceType: "hour_entry",
      resourceId: created.id,
      metadata: { opportunityId: created.opportunityId, shiftId: created.shiftId, durationMinutes },
    });
  });

  return { hourEntryId };
}
