import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import { getOpportunityById } from "@/modules/volunteering";
import type { HoursApprovedPayload } from "../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../domain/errors";
import { recordProcessedEventAndProject, type ProjectionResult } from "./idempotentProjection";

function formatHours(durationMinutes: number): number {
  return Math.round((durationMinutes / 60) * 10) / 10;
}

/**
 * `HandleHoursApproved` (docs/ddd/community-social.md, Integration &
 * Anti-Corruption Notes) — mirrors `volunteering`'s `HoursApproved`
 * producer (`application/approveHours.ts`). Resolves `subjectDisplayName`
 * via `identity.getPersonSummary` and the Opportunity's `title` via
 * `volunteering.getOpportunityById` (the payload itself carries only
 * `opportunityId`, not its display title).
 *
 * Creates an IMMUTABLE snapshot `FeedEntry` (`kind = 'hours_approved'`,
 * FeedEntry invariant 1).
 *
 * Scope: "taken from the event payload's chapter ... never re-derived by
 * a lookup" (this doc's own Integration Notes, verbatim) —
 * `payload.chapterId` (Volunteering publishes the Opportunity's own
 * chapter on this event) maps directly to `scopeType`/`scopeId`, `null`
 * meaning an org-wide Opportunity, same convention `community.post` uses.
 */
export async function handleHoursApproved(
  prisma: PrismaClient,
  payload: HoursApprovedPayload,
  sourceEventId: string,
): Promise<ProjectionResult> {
  const [person, opportunity] = await Promise.all([
    getPersonSummary(prisma, payload.personId),
    getOpportunityById(prisma, payload.opportunityId),
  ]);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }
  if (!opportunity) {
    throw new SourceRecordNotFoundError("volunteering.opportunity", payload.opportunityId);
  }

  const hours = formatHours(payload.durationMinutes);

  return recordProcessedEventAndProject(
    prisma,
    { id: sourceEventId, sourceContext: "volunteering", eventType: "HoursApproved" },
    async (tx) => {
      await tx.feedEntry.create({
        data: {
          id: newId(),
          kind: "hours_approved",
          scopeType: payload.chapterId ? "chapter" : "org",
          scopeId: payload.chapterId,
          subjectPersonId: payload.personId,
          subjectDisplayName: person.displayName,
          sourceType: "volunteering.hour_entry",
          sourceId: payload.hourEntryId,
          sourceEventId,
          summary: `${person.displayName} logged ${hours} hour${hours === 1 ? "" : "s"} for ${opportunity.title}`,
          payload: { hours, opportunityTitle: opportunity.title },
        },
      });
    },
  );
}
