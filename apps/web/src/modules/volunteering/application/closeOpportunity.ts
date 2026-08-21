import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { InvalidOpportunityTransitionError, OpportunityNotFoundError } from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * CloseOpportunity — the `published -> closed` transition of the
 * Opportunity state machine (volunteering-opportunities.md's diagram).
 * Same chapter-scoped authority as `PublishOpportunity`; no separate Key
 * Use Case number or domain event is documented for this transition (the
 * Domain Events table's only Opportunity-lifecycle event is
 * `OpportunityPublished`), so this only records an audit event.
 *
 * *Pre:* Opportunity is `published`; caller holds `chapter_lead` (for the
 * target chapter) or `org_admin`.
 *
 * *Post:* `status = 'closed'`, `closedAt` set. Existing `Shift`/
 * `Application`/`HourEntry` rows are untouched (Opportunity invariant 3 —
 * "historical shifts under a closed Opportunity remain queryable").
 */
export interface CloseOpportunityInput {
  caller: PolicySubject;
  opportunityId: string;
}

export async function closeOpportunity(prisma: PrismaClient, input: CloseOpportunityInput): Promise<void> {
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

  if (opportunity.status !== "published") {
    throw new InvalidOpportunityTransitionError(opportunity.id, opportunity.status, "closed");
  }

  await prisma.$transaction(async (tx) => {
    await tx.opportunity.update({
      where: { id: opportunity.id, status: "published" },
      data: { status: "closed", closedAt: new Date() },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "opportunity.close",
      resourceType: "opportunity",
      resourceId: opportunity.id,
      scopeType: opportunity.chapterId ? "chapter" : "global",
      scopeId: opportunity.chapterId ?? undefined,
    });
  });
}
