import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import type { StreakExtendedPayload } from "../domain/inboundEvents";
import { isMilestoneStreakLength } from "../domain/streakMilestones";
import { PersonNotFoundError } from "../domain/errors";
import { recordProcessedEventAndProject, type ProjectionResult } from "./idempotentProjection";

/**
 * `HandleStreakExtended` (docs/ddd/community-social.md, Integration &
 * Anti-Corruption Notes) — mirrors `gamification`'s `StreakExtended`
 * producer (`application/updateStreak.ts`). **Filtered at the handler**:
 * only a milestone `currentLength` (`domain/streakMilestones.ts`) produces
 * a `FeedEntry`; every other day's `StreakExtended` is still acknowledged
 * (the `processed_events` row is written either way, inside the same
 * `recordProcessedEventAndProject` transaction, so it is never
 * reprocessed) but intentionally produces no feed row, to avoid daily
 * feed spam — a product decision, not a technical limitation, per the
 * doc's own framing.
 *
 * Creates an IMMUTABLE snapshot `FeedEntry` (`kind = 'streak_extended'`,
 * FeedEntry invariant 1) on milestone days.
 *
 * Scope: `StreakExtended`'s payload carries no chapter, so this projects
 * org-wide (`scopeType: 'org'`) on milestone days, the same default this
 * module uses for every other consumed kind whose payload carries no
 * chapter.
 */
export async function handleStreakExtended(
  prisma: PrismaClient,
  payload: StreakExtendedPayload,
  sourceEventId: string,
): Promise<ProjectionResult> {
  const person = await getPersonSummary(prisma, payload.personId);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }

  const isMilestone = isMilestoneStreakLength(payload.currentLength);

  return recordProcessedEventAndProject(
    prisma,
    { id: sourceEventId, sourceContext: "gamification", eventType: "StreakExtended" },
    async (tx) => {
      if (!isMilestone) {
        return;
      }
      await tx.feedEntry.create({
        data: {
          id: newId(),
          kind: "streak_extended",
          scopeType: "org",
          scopeId: null,
          subjectPersonId: payload.personId,
          subjectDisplayName: person.displayName,
          sourceType: "gamification.streak",
          // Neither `StreakExtended`'s own payload nor
          // `getPersonGamificationProfile`'s `StreakDTO` exposes
          // `gamification.streak.id` (only `personId`/`activityType`/
          // `currentLength`/...) — `(personId, activityType)` is itself
          // `gamification.streak`'s own natural key (its `@@unique`), so
          // this composite string is a stable, honest substitute rather
          // than a real cross-schema id this handler has no way to obtain.
          // Not load-bearing for idempotency either way — that's
          // `sourceEventId`/`uq_feed_entry_source_event`, not this field.
          sourceId: `${payload.personId}:${payload.activityType}`,
          sourceEventId,
          summary: `${person.displayName} reached a ${payload.currentLength}-day streak`,
          payload: { activityType: payload.activityType, currentLength: payload.currentLength },
        },
      });
    },
  );
}
