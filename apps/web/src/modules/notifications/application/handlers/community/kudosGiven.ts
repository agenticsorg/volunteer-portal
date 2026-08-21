import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import type { KudosGivenPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleKudosGiven` — mirrors `community`'s `KudosGiven` producer
 * (`application/giveKudos.ts`). The payload carries only `fromPersonId`
 * (not a display name), so it's resolved via `identity.getPersonSummary`;
 * `toPersonId` (the recipient) is validated the same way, defense-in-depth
 * against queueing a notification for a Person that doesn't resolve.
 *
 * Recipient: `payload.toPersonId` (the kudos recipient — the giver,
 * `fromPersonId`, is the actor, never notified about their own action).
 * `kudos_given` is a social/engagement type, defaulted enabled on both
 * channels.
 */
export async function handleKudosGiven(
  prisma: PrismaClient,
  payload: KudosGivenPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const [fromPerson, toPerson] = await Promise.all([
    getPersonSummary(prisma, payload.fromPersonId),
    getPersonSummary(prisma, payload.toPersonId),
  ]);
  if (!fromPerson) {
    throw new PersonNotFoundError(payload.fromPersonId);
  }
  if (!toPerson) {
    throw new PersonNotFoundError(payload.toPersonId);
  }

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "community", eventType: "KudosGiven" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.toPersonId,
        type: "kudos_given",
        requestedChannels: ["email", "in_app"],
        sourceContext: "community",
        sourceEventId,
        payload: { kudosId: payload.kudosId, fromDisplayName: fromPerson.displayName },
      });
    },
  );
}
