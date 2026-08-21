import type { PrismaClient } from "@prisma/client";
import type { InboundEvent, ModerationActionTakenPayload } from "../domain/inboundEvents";
import { handleModerationActionTaken } from "./handlers/moderation/moderationActionTaken";
import type { ConsumptionResult } from "./idempotentConsumption";
import type { ConsumeEventResult } from "./consumeVolunteeringEvents";

const RECOGNIZED_EVENT_TYPES = ["ModerationActionTaken"] as const;

/**
 * `ConsumeModerationEvents` — see `consumeVolunteeringEvents.ts`'s own doc
 * comment for the shared design rationale. Handles
 * `moderation.domain_events`' `ModerationActionTaken`
 * (`ReportFiled`/`ReportResolved`/`ReportDismissed`/`ModerationActionRevoked`
 * are also published by `moderation` but are not in this stage's Build
 * list — normal `recognized: false` no-ops here).
 */
export async function consumeModerationEvents(prisma: PrismaClient, event: InboundEvent): Promise<ConsumeEventResult> {
  if (!RECOGNIZED_EVENT_TYPES.includes(event.eventType as (typeof RECOGNIZED_EVENT_TYPES)[number])) {
    return { processed: false, recognized: false };
  }

  let result: ConsumptionResult;
  switch (event.eventType) {
    case "ModerationActionTaken":
      result = await handleModerationActionTaken(prisma, event.payload as ModerationActionTakenPayload, event.sourceEventId);
      break;
    default:
      return { processed: false, recognized: false };
  }

  return { processed: result.processed, recognized: true };
}
