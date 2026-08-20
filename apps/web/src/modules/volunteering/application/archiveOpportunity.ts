import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  InvalidOpportunityTransitionError,
  OpportunityHasScheduledShiftsError,
  OpportunityNotFoundError,
} from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * ArchiveOpportunity — the `closed -> archived` transition (the terminal
 * state on volunteering-opportunities.md's diagram). Same chapter-scoped
 * authority as `PublishOpportunity`/`CloseOpportunity`; no domain event
 * documented for this transition (audit-only, same as `CloseOpportunity`).
 *
 * *Pre:* Opportunity is `closed`; no `Shift` under it is `status =
 * 'scheduled'` (Opportunity invariant 4); caller holds `chapter_lead` (for
 * the target chapter) or `org_admin`.
 *
 * *Post:* `status = 'archived'`.
 */
export interface ArchiveOpportunityInput {
  caller: PolicySubject;
  opportunityId: string;
}

export async function archiveOpportunity(prisma: PrismaClient, input: ArchiveOpportunityInput): Promise<void> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: { id: true, chapterId: true, status: true },
  });
  if (!opportunity) {
    throw new OpportunityNotFoundError(input.opportunityId);
  }

  await assertVolunteeringAuthority(
    prisma,
    input.caller,
    "opportunity.manage",
    "opportunity",
    opportunity.chapterId,
  );

  if (opportunity.status !== "closed") {
    throw new InvalidOpportunityTransitionError(opportunity.id, opportunity.status, "archived");
  }

  const scheduledShiftCount = await prisma.shift.count({
    where: { opportunityId: opportunity.id, status: "scheduled" },
  });
  if (scheduledShiftCount > 0) {
    throw new OpportunityHasScheduledShiftsError(opportunity.id);
  }

  await prisma.$transaction(async (tx) => {
    await tx.opportunity.update({
      where: { id: opportunity.id, status: "closed" },
      data: { status: "archived" },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "opportunity.archive",
      resourceType: "opportunity",
      resourceId: opportunity.id,
      scopeType: opportunity.chapterId ? "chapter" : "global",
      scopeId: opportunity.chapterId ?? undefined,
    });
  });
}
