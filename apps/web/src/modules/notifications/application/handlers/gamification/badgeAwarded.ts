import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import { getPersonGamificationProfile } from "@/modules/gamification";
import type { BadgeAwardedPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleBadgeAwarded` — mirrors `gamification`'s `BadgeAwarded` producer
 * (`application/awardBadge.ts`). That producer's payload carries only
 * `personId`/`badgeId`/`badgeAwardId`, not the badge's display `name`, so
 * this resolves it via `gamification.getPersonGamificationProfile` — the
 * one synchronous cross-context read `community`'s own
 * `handleBadgeAwarded.ts` already established for this identical payload.
 *
 * Recipient: `payload.personId`. `badge_awarded` is a social/engagement
 * type, defaulted enabled on both channels (see
 * `@volunteer-portal/shared`'s `notificationDefaults.ts`) — requested on
 * both, narrowed by the QUEUE-TIME gate.
 */
export async function handleBadgeAwarded(
  prisma: PrismaClient,
  payload: BadgeAwardedPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
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

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "gamification", eventType: "BadgeAwarded" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.personId,
        type: "badge_awarded",
        requestedChannels: ["email", "in_app"],
        sourceContext: "gamification",
        sourceEventId,
        payload: { badgeAwardId: payload.badgeAwardId, badgeName: award.badge.name, badgeIconKey: award.badge.iconUrl },
      });
    },
  );
}
