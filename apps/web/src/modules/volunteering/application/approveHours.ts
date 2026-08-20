import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { HourEntryNotFoundError, HourEntryNotSubmittedError, SelfApprovalNotAllowedError } from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * ApproveHours (docs/ddd/volunteering-opportunities.md, Key Use Case 8).
 *
 * *Pre:* `HourEntry.status = 'submitted'`; caller holds `chapter_lead`,
 * `mentor`, or `org_admin` scoped to the entry's Opportunity's chapter
 * (`hour_entry.approve`); caller ≠ `personId` (no self-approval — HourEntry
 * invariant 2).
 *
 * *Post:* `status = 'approved'`, `approverPersonId`/`approvedAt` set — and
 * from this point the row is **immutable** (ADR-0014 / HourEntry invariant
 * 3): no function in this module ever updates a `HourEntry` again outside
 * `ApproveHours`/`RejectHours`, and both require `status = 'submitted'` as
 * a precondition (`HourEntryNotSubmittedError` otherwise), so a
 * once-approved row can never re-enter either. The DB trigger
 * `trg_hour_entries_immutable` is the defense-in-depth backstop for the
 * same invariant. `HoursApproved` emitted — the trigger the entire
 * points-awarding side of Gamification depends on
 * (volunteering-opportunities.md: "the single most important **outbound**
 * event this context publishes").
 */
export interface ApproveHoursInput {
  caller: PolicySubject;
  hourEntryId: string;
}

export async function approveHours(prisma: PrismaClient, input: ApproveHoursInput): Promise<void> {
  const entry = await prisma.hourEntry.findUnique({
    where: { id: input.hourEntryId },
    select: {
      id: true,
      personId: true,
      opportunityId: true,
      shiftId: true,
      durationMinutes: true,
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
    "hour_entry.approve",
    "hour_entry",
    entry.opportunity.chapterId,
  );

  if (entry.status !== "submitted") {
    throw new HourEntryNotSubmittedError(entry.id, entry.status);
  }

  await prisma.$transaction(async (tx) => {
    const approvedAt = new Date();
    const approved = await tx.hourEntry.update({
      where: { id: entry.id, status: "submitted" },
      data: { status: "approved", approverPersonId: input.caller.id, approvedAt },
      select: { id: true, personId: true, opportunityId: true, shiftId: true, durationMinutes: true, approverPersonId: true, approvedAt: true },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "HourEntry",
        aggregateId: approved.id,
        eventType: "HoursApproved",
        payload: {
          hourEntryId: approved.id,
          personId: approved.personId,
          opportunityId: approved.opportunityId,
          shiftId: approved.shiftId,
          chapterId: entry.opportunity.chapterId,
          durationMinutes: approved.durationMinutes,
          approverPersonId: approved.approverPersonId,
          approvedAt: approved.approvedAt!.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "hour_entry.approve",
      resourceType: "hour_entry",
      resourceId: approved.id,
      scopeType: entry.opportunity.chapterId ? "chapter" : "global",
      scopeId: entry.opportunity.chapterId ?? undefined,
      metadata: { personId: approved.personId, durationMinutes: approved.durationMinutes },
    });
  });
}
