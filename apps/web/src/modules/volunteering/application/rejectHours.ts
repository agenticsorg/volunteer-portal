import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  HourEntryNotFoundError,
  HourEntryNotSubmittedError,
  RejectionReasonRequiredError,
  SelfApprovalNotAllowedError,
} from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * RejectHours (docs/ddd/volunteering-opportunities.md, Key Use Case 9).
 *
 * *Pre:* `HourEntry.status = 'submitted'`; caller authorized as
 * `ApproveHours` (`hour_entry.reject` — same chapter-scoped authority,
 * HourEntry invariant 2 covers "approve/reject" together); non-empty
 * `rejectionReason` supplied (invariant 4).
 *
 * *Post:* `status = 'rejected'`, `approverPersonId`/`rejectedAt`/
 * `rejectionReason` set (terminal for this row — "volunteer may submit a
 * NEW entry, never reopen this one"); `HoursRejected` emitted.
 */
export interface RejectHoursInput {
  caller: PolicySubject;
  hourEntryId: string;
  rejectionReason: string;
}

export async function rejectHours(prisma: PrismaClient, input: RejectHoursInput): Promise<void> {
  if (!input.rejectionReason.trim()) {
    throw new RejectionReasonRequiredError();
  }

  const entry = await prisma.hourEntry.findUnique({
    where: { id: input.hourEntryId },
    select: {
      id: true,
      personId: true,
      opportunityId: true,
      status: true,
      opportunity: { select: { chapterId: true } },
    },
  });
  if (!entry) {
    throw new HourEntryNotFoundError(input.hourEntryId);
  }

  if (input.caller.id === entry.personId) {
    throw new SelfApprovalNotAllowedError(entry.id);
  }

  await assertVolunteeringAuthority(
    prisma,
    input.caller,
    "hour_entry.reject",
    "hour_entry",
    entry.opportunity.chapterId,
  );

  if (entry.status !== "submitted") {
    throw new HourEntryNotSubmittedError(entry.id, entry.status);
  }

  await prisma.$transaction(async (tx) => {
    const rejectedAt = new Date();
    const rejected = await tx.hourEntry.update({
      where: { id: entry.id, status: "submitted" },
      data: {
        status: "rejected",
        approverPersonId: input.caller.id,
        rejectedAt,
        rejectionReason: input.rejectionReason,
      },
      select: { id: true, personId: true, opportunityId: true, approverPersonId: true, rejectedAt: true, rejectionReason: true },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "HourEntry",
        aggregateId: rejected.id,
        eventType: "HoursRejected",
        payload: {
          hourEntryId: rejected.id,
          personId: rejected.personId,
          opportunityId: rejected.opportunityId,
          approverPersonId: rejected.approverPersonId,
          rejectedAt: rejected.rejectedAt!.toISOString(),
          rejectionReason: rejected.rejectionReason,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "hour_entry.reject",
      resourceType: "hour_entry",
      resourceId: rejected.id,
      scopeType: entry.opportunity.chapterId ? "chapter" : "global",
      scopeId: entry.opportunity.chapterId ?? undefined,
      metadata: { personId: rejected.personId, rejectionReason: input.rejectionReason },
    });
  });
}
