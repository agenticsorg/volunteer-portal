import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import { getPersonGamificationProfile } from "@/modules/gamification";
import type { BadgeAwardedPayload } from "../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../domain/errors";
import { recordProcessedEventAndProject, type ProjectionResult } from "./idempotentProjection";

/**
 * `HandleBadgeAwarded` (docs/ddd/community-social.md, Integration &
 * Anti-Corruption Notes) — mirrors `gamification`'s `BadgeAwarded`
 * producer (`application/awardBadge.ts`). Resolves `subjectDisplayName`
 * via `identity.getPersonSummary` and the badge's own `name`/`iconUrl` via
 * `gamification.getPersonGamificationProfile` (the one synchronous
 * cross-context read docs/ddd/community-social.md's own Integration Notes
 * sanctions — "this context never joins into gamification ... tables";
 * `awardBadge`'s own outbox payload carries only `personId`/`badgeId`/
 * `badgeAwardId`, not the badge's display fields, so this handler resolves
 * them through gamification's own Open Host Service query rather than a
 * cross-schema join).
 *
 * Creates an IMMUTABLE snapshot `FeedEntry` (`kind = 'badge_awarded'`,
 * FeedEntry invariant 1) — `summary`/`payload` are captured once, here,
 * and never re-read from `gamification` again, so a later badge-definition
 * edit (even deactivation) does not alter this row (Phase 6's own
 * completion bar).
 *
 * Scope: `BadgeAwarded`'s payload carries no chapter (unlike
 * `HoursApproved`'s, which Volunteering publishes explicitly), and
 * `identity.getPersonSummary`'s contract deliberately excludes chapter
 * membership — so, absent a chapter to scope to, this projects org-wide
 * (`scopeType: 'org'`), the same default this module uses for every other
 * consumed kind whose payload carries no chapter of its own.
 */
export async function handleBadgeAwarded(
  prisma: PrismaClient,
  payload: BadgeAwardedPayload,
  sourceEventId: string,
): Promise<ProjectionResult> {
  const [person, profile] = await Promise.all([
    getPersonSummary(prisma, payload.personId),
    getPersonGamificationProfile(prisma, payload.personId),
  ]);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }
  const award = profile.badges.find((b) => b.badgeAwardId === payload.badgeAwardId);
  if (!award) {
    throw new SourceRecordNotFoundError("gamification.badge_award", payload.badgeAwardId);
  }

  return recordProcessedEventAndProject(
    prisma,
    { id: sourceEventId, sourceContext: "gamification", eventType: "BadgeAwarded" },
    async (tx) => {
      await tx.feedEntry.create({
        data: {
          id: newId(),
          kind: "badge_awarded",
          scopeType: "org",
          scopeId: null,
          subjectPersonId: payload.personId,
          subjectDisplayName: person.displayName,
          sourceType: "gamification.badge_award",
          sourceId: payload.badgeAwardId,
          sourceEventId,
          summary: `${person.displayName} earned the ${award.badge.name} badge`,
          payload: { badgeName: award.badge.name, badgeIconKey: award.badge.iconUrl },
        },
      });
    },
  );
}
