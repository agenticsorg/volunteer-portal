import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import type { ModerationActionTakenPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleModerationActionTaken` — mirrors `moderation`'s
 * `ModerationActionTaken` producer (`application/takeModerationAction.ts`).
 * The payload is already fully self-sufficient (`actionType`, `scopeType`,
 * `scopeId`, `endsAt`) — no cross-context Open Host Service read needed.
 *
 * Recipient: `payload.targetPersonId` (the person the action was taken
 * against — `moderatorPersonId` is the actor, never notified about their
 * own action). `moderation_action` is an operational/transactional type,
 * defaulted enabled on both channels — deliberately not gateable away
 * entirely by an opted-out channel default, though a person's own explicit
 * `NotificationPreference` override still applies per Notification
 * invariant 1 (this is a per-channel delivery preference, not a way to
 * suppress being informed a sanction exists at all).
 */
export async function handleModerationActionTaken(
  prisma: PrismaClient,
  payload: ModerationActionTakenPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const target = await getPersonSummary(prisma, payload.targetPersonId);
  if (!target) {
    throw new PersonNotFoundError(payload.targetPersonId);
  }

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "moderation", eventType: "ModerationActionTaken" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.targetPersonId,
        type: "moderation_action",
        requestedChannels: ["email", "in_app"],
        sourceContext: "moderation",
        sourceEventId,
        payload: {
          actionId: payload.actionId,
          actionType: payload.actionType,
          scopeType: payload.scopeType,
          scopeId: payload.scopeId,
          endsAt: payload.endsAt,
        },
      });
    },
  );
}
