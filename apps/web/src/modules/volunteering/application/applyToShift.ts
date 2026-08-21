import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import { DuplicateApplicationError, PersonNotFoundError, ShiftNotFoundError, ShiftNotOpenError } from "../domain/errors";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * ApplyToShift (docs/ddd/volunteering-opportunities.md, Key Use Case 4).
 * Self-service — the applicant acts on their own behalf, so this is not
 * `can()`-gated (same shape as `identity`'s `RegisterPerson`).
 *
 * *Pre:* Shift is `scheduled` and in the future; applicant has no existing
 * non-terminal/accepted Application for this shift (Application invariant
 * 1 — the DB's `uq_applications_active_per_shift` partial unique index is
 * the real concurrency backstop, same "pre-check + unique-constraint
 * backstop" shape as `identity`'s `createChapter`); applicant meets
 * `Opportunity.minAge`.
 *
 * The `minAge` check is a **documented, unenforced gap** above the
 * platform-wide default: `identity`'s Open Host Service
 * (`getPersonSummary`) deliberately excludes `dateOfBirth` as sensitive PII
 * (see `PersonPublicSummary`'s own doc comment), and this module may only
 * ever read Person data through that query — so a per-Opportunity `minAge`
 * raised *above* the platform's own registration-time age gate (16, or a
 * guardian-consented exception) cannot be verified precisely from inside
 * this module today. The default `minAge = 16` case is satisfied by
 * construction (identity-access.md Person invariant 2 already guarantees
 * every registered Person is 16+ or guardian-consented); `minAge > 16`
 * would need a narrower Identity OHS query this phase does not add. Same
 * "documented stub, not a silent gap" shape as `hasCompletedRequiredTraining`.
 *
 * *Post:* New `Application(status = 'pending')` row exists;
 * `ApplicationSubmitted` emitted.
 */
export interface ApplyToShiftInput {
  applicantPersonId: string;
  shiftId: string;
}

export interface SubmittedApplication {
  applicationId: string;
}

export async function applyToShift(prisma: PrismaClient, input: ApplyToShiftInput): Promise<SubmittedApplication> {
  const applicant = await getPersonSummary(prisma, input.applicantPersonId);
  if (!applicant) {
    throw new PersonNotFoundError(input.applicantPersonId);
  }

  const shift = await prisma.shift.findUnique({
    where: { id: input.shiftId },
    select: { id: true, status: true, startsAt: true },
  });
  if (!shift) {
    throw new ShiftNotFoundError(input.shiftId);
  }
  if (shift.status !== "scheduled") {
    throw new ShiftNotOpenError(shift.id, `status is "${shift.status}", not "scheduled".`);
  }
  if (shift.startsAt.getTime() <= Date.now()) {
    throw new ShiftNotOpenError(shift.id, "the shift has already started.");
  }

  const existing = await prisma.application.findFirst({
    where: {
      shiftId: shift.id,
      applicantPersonId: input.applicantPersonId,
      status: { in: ["pending", "accepted", "waitlisted"] },
    },
    select: { id: true },
  });
  if (existing) {
    throw new DuplicateApplicationError(input.applicantPersonId, shift.id);
  }

  const applicationId = newId();
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.application.create({
        data: {
          id: applicationId,
          shiftId: shift.id,
          applicantPersonId: input.applicantPersonId,
        },
        select: { id: true, shiftId: true, applicantPersonId: true, appliedAt: true },
      });

      await tx.volunteeringDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "Application",
          aggregateId: created.id,
          eventType: "ApplicationSubmitted",
          payload: {
            applicationId: created.id,
            shiftId: created.shiftId,
            applicantPersonId: created.applicantPersonId,
            appliedAt: created.appliedAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      throw new DuplicateApplicationError(input.applicantPersonId, shift.id);
    }
    throw error;
  }

  return { applicationId };
}
