import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { listChapters } from "@/modules/identity";
import {
  InvalidOpportunityTransitionError,
  OpportunityNotFoundError,
  OpportunityNotPublishableError,
} from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/**
 * PublishOpportunity (docs/ddd/volunteering-opportunities.md, Key Use Case 1).
 *
 * *Pre:* Opportunity exists in `draft` with non-empty `title`/`description`;
 * `chapterId` is either `null` (org-wide) or references a chapter Identity
 * currently reports active (Opportunity invariant 1 — checked here via
 * `identity`'s exported `listChapters` Open Host Service read, never a
 * direct query against `identity.chapters`); caller holds `chapter_lead`
 * (for the target chapter) or `org_admin`.
 *
 * *Post:* `status = 'published'`, `publishedAt` set; `OpportunityPublished`
 * emitted.
 */
export interface PublishOpportunityInput {
  caller: PolicySubject;
  opportunityId: string;
}

export async function publishOpportunity(prisma: PrismaClient, input: PublishOpportunityInput): Promise<void> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: { id: true, chapterId: true, title: true, description: true, status: true },
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

  if (opportunity.status !== "draft") {
    throw new InvalidOpportunityTransitionError(opportunity.id, opportunity.status, "published");
  }
  if (!opportunity.title.trim() || !opportunity.description.trim()) {
    throw new OpportunityNotPublishableError(opportunity.id, "title and description must be non-empty.");
  }
  if (opportunity.chapterId !== null) {
    const activeChapters = await listChapters(prisma, { status: "active" });
    const chapterIsActive = activeChapters.some((chapter) => chapter.chapterId === opportunity.chapterId);
    if (!chapterIsActive) {
      throw new OpportunityNotPublishableError(
        opportunity.id,
        `chapter "${opportunity.chapterId}" is not currently active.`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const publishedAt = new Date();
    const published = await tx.opportunity.update({
      where: { id: opportunity.id, status: "draft" },
      data: { status: "published", publishedAt },
      select: { id: true, chapterId: true, title: true, category: true, publishedAt: true },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Opportunity",
        aggregateId: published.id,
        eventType: "OpportunityPublished",
        payload: {
          opportunityId: published.id,
          chapterId: published.chapterId,
          title: published.title,
          category: published.category,
          publishedAt: published.publishedAt!.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "opportunity.publish",
      resourceType: "opportunity",
      resourceId: published.id,
      scopeType: published.chapterId ? "chapter" : "global",
      scopeId: published.chapterId ?? undefined,
    });
  });
}
