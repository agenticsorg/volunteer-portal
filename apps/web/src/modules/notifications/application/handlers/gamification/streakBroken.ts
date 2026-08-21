import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import type { StreakBrokenPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleStreakBroken` — mirrors `gamification`'s `StreakBroken` producer
 * (`application/updateStreak.ts`). The payload is already fully
 * self-sufficient to render from (`activityType`, `previousLength`) — no
 * cross-context read is needed to build the notification's own `payload`,
 * but `identity.getPersonSummary` is still called to validate
 * `payload.personId` resolves to a real Person before queueing, same
 * defense-in-depth precedent every other handler in this module (and
 * `community`'s own `handleStreakExtended.ts`) applies.
 *
 * Recipient: `payload.personId`. `streak_broken` is a social/engagement
 * type, defaulted enabled on both channels.
 */
export async function handleStreakBroken(
  prisma: PrismaClient,
  payload: StreakBrokenPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const person = await getPersonSummary(prisma, payload.personId);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "gamification", eventType: "StreakBroken" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.personId,
        type: "streak_broken",
        requestedChannels: ["email", "in_app"],
        sourceContext: "gamification",
        sourceEventId,
        payload: { activityType: payload.activityType, previousLength: payload.previousLength },
      });
    },
  );
}
