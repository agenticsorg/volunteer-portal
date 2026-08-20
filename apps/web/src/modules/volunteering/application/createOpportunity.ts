import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * CreateOpportunity — the entry point into the Opportunity state machine
 * (docs/ddd/volunteering-opportunities.md's `draft -> published -> closed ->
 * archived` diagram; API Contract Sketch's `opportunities.create`). Not a
 * separately numbered Key Use Case in the doc (PublishOpportunity, Key Use
 * Case 1, is the first one spelled out), but required for the documented
 * state machine to have a starting `draft` row at all, and the contract
 * sketch's own comment on this mutation ("requires
 * `can(caller, 'opportunity.create', {chapterId})`") gives it the exact
 * same chapter-scoped authority as every other Opportunity-management
 * action.
 *
 * *Pre:* caller holds `chapter_lead` scoped to `chapterId` (or `org_admin`
 * — required outright when `chapterId` is `null`, an org-wide Opportunity).
 *
 * *Post:* a new `Opportunity(status = 'draft')` row exists. No domain event
 * is emitted — the Domain Events table's first Opportunity-lifecycle event
 * is `OpportunityPublished`; a still-`draft` row is not yet visible to any
 * other bounded context.
 */
export interface CreateOpportunityInput {
  caller: PolicySubject;
  chapterId: string | null;
  title: string;
  description: string;
  category: string;
  skillsRequired: string[];
  locationType: "in_person" | "remote" | "hybrid";
  minAge: number;
  prerequisiteCourseIds: string[];
}

export interface CreatedOpportunity {
  opportunityId: string;
}

export async function createOpportunity(
  prisma: PrismaClient,
  input: CreateOpportunityInput,
): Promise<CreatedOpportunity> {
  await assertVolunteeringAuthority(prisma, input.caller, "opportunity.create", "opportunity", input.chapterId);

  const opportunityId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.opportunity.create({
      data: {
        id: opportunityId,
        chapterId: input.chapterId,
        title: input.title,
        description: input.description,
        category: input.category,
        skillsRequired: input.skillsRequired,
        locationType: input.locationType,
        minAge: input.minAge,
        prerequisiteCourseIds: input.prerequisiteCourseIds,
        createdByPersonId: input.caller.id,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "opportunity.create",
      resourceType: "opportunity",
      resourceId: opportunityId,
      scopeType: input.chapterId ? "chapter" : "global",
      scopeId: input.chapterId ?? undefined,
      metadata: { title: input.title, category: input.category },
    });
  });

  return { opportunityId };
}
