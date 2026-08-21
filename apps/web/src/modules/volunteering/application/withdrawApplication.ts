import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { ApplicationNotFoundError, ApplicationNotWithdrawableError, NotTheApplicantError } from "../domain/errors";

const WITHDRAWABLE_STATUSES = ["pending", "accepted", "waitlisted"] as const;

/**
 * WithdrawApplication (docs/ddd/volunteering-opportunities.md, Key Use
 * Case 6). Self-service — only the applicant may withdraw their own
 * application, so this is not `can()`-gated (a structural
 * `callerId === applicantPersonId` check instead, same shape as
 * `identity`'s DSAR "self, or org_admin" checks but without the org_admin
 * escape hatch — the doc's Application invariant 3 says "only callable by
 * the applicant themself," full stop).
 *
 * *Pre:* Caller is the applicant; Application is `pending`/`accepted`/
 * `waitlisted`.
 *
 * *Post:* `status = 'withdrawn'`; if it was `accepted`, `Shift.acceptedCount`
 * is decremented and **Waitlist Promotion** runs in the same transaction:
 * the earliest `waitlisted` row on this shift by `appliedAt`, if any, is
 * promoted to `accepted` (its own `Shift.acceptedCount` increment is folded
 * into the same decrement — see below — and it emits its own
 * `ApplicationAccepted`); `ApplicationWithdrawn` emitted for the withdrawn
 * row.
 */
export interface WithdrawApplicationInput {
  callerId: string;
  applicationId: string;
}

export async function withdrawApplication(prisma: PrismaClient, input: WithdrawApplicationInput): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { id: input.applicationId },
    select: { id: true, shiftId: true, applicantPersonId: true, status: true },
  });
  if (!application) {
    throw new ApplicationNotFoundError(input.applicationId);
  }
  if (application.applicantPersonId !== input.callerId) {
    throw new NotTheApplicantError(application.id);
  }
  if (!WITHDRAWABLE_STATUSES.includes(application.status as (typeof WITHDRAWABLE_STATUSES)[number])) {
    throw new ApplicationNotWithdrawableError(application.id, application.status);
  }

  const withdrawnAt = new Date();
  const wasAccepted = application.status === "accepted";

  await prisma.$transaction(async (tx) => {
    await tx.application.update({
      where: { id: application.id },
      data: { status: "withdrawn", decidedByPersonId: input.callerId, decidedAt: withdrawnAt },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Application",
        aggregateId: application.id,
        eventType: "ApplicationWithdrawn",
        payload: {
          applicationId: application.id,
          shiftId: application.shiftId,
          applicantPersonId: application.applicantPersonId,
          withdrawnAt: withdrawnAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    if (wasAccepted) {
      // Frees exactly the one slot this withdrawal vacated. A plain
      // decrement (not the accept-path's conditional `WHERE accepted_count
      // < capacity` — there is no capacity ceiling to check when *freeing*
      // a slot) guarded by `accepted_count > 0` so a corrupted/negative
      // counter can never occur even in a code path that shouldn't be
      // reachable given `wasAccepted` was just verified.
      await tx.$executeRaw`
        UPDATE volunteering.shifts
        SET accepted_count = accepted_count - 1, updated_at = now()
        WHERE id = ${application.shiftId} AND accepted_count > 0
      `;

      const earliestWaitlisted = await tx.application.findFirst({
        where: { shiftId: application.shiftId, status: "waitlisted" },
        orderBy: { appliedAt: "asc" },
        select: { id: true, shiftId: true, applicantPersonId: true, shift: { select: { opportunityId: true } } },
      });

      if (earliestWaitlisted) {
        const promotedAt = new Date();
        // The slot just freed above is reserved for this promotion — a
        // conditional increment (mirroring `decideApplication`'s accept
        // path) rather than an unconditional one, so this stays correct
        // even if some other concurrent transaction also freed/claimed
        // capacity on this exact shift between the decrement above and
        // this increment.
        const promoted = await tx.$executeRaw`
          UPDATE volunteering.shifts
          SET accepted_count = accepted_count + 1, updated_at = now()
          WHERE id = ${earliestWaitlisted.shiftId} AND accepted_count < capacity
        `;

        if (promoted === 1) {
          await tx.application.update({
            where: { id: earliestWaitlisted.id, status: "waitlisted" },
            data: {
              status: "accepted",
              decidedByPersonId: null,
              decidedAt: promotedAt,
              decisionNote: "Auto-promoted from waitlist (capacity freed by a withdrawal).",
            },
          });

          await tx.volunteeringDomainEvent.create({
            data: {
              id: newId(),
              aggregateType: "Application",
              aggregateId: earliestWaitlisted.id,
              eventType: "ApplicationAccepted",
              payload: {
                applicationId: earliestWaitlisted.id,
                shiftId: earliestWaitlisted.shiftId,
                opportunityId: earliestWaitlisted.shift.opportunityId,
                applicantPersonId: earliestWaitlisted.applicantPersonId,
                decidedAt: promotedAt.toISOString(),
              } satisfies Prisma.InputJsonValue,
            },
          });
        }
      }
    }

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.callerId,
      actorType: "user",
      action: "application.withdraw",
      resourceType: "application",
      resourceId: application.id,
    });
  });
}
