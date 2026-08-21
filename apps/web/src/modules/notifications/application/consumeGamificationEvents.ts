import type { PrismaClient } from "@prisma/client";
import type { BadgeAwardedPayload, InboundEvent, StreakBrokenPayload } from "../domain/inboundEvents";
import { handleBadgeAwarded } from "./handlers/gamification/badgeAwarded";
import { handleStreakBroken } from "./handlers/gamification/streakBroken";
import type { ConsumptionResult } from "./idempotentConsumption";
import type { ConsumeEventResult } from "./consumeVolunteeringEvents";

const RECOGNIZED_EVENT_TYPES = ["BadgeAwarded", "StreakBroken"] as const;

/**
 * `ConsumeGamificationEvents` — see `consumeVolunteeringEvents.ts`'s own
 * doc comment for the shared design rationale (one job per source schema,
 * a `switch` dispatcher for concrete per-event payload types). Handles
 * `gamification.domain_events`' `BadgeAwarded` and `StreakBroken`
 * (`PointsAwarded`/`StreakExtended`/`StreakFrozen` are published by
 * `gamification` too, but are not in this stage's Build list — an
 * unrecognized-but-legitimate event type from this same source schema is a
 * normal no-op, `recognized: false`, exactly like every other
 * per-source-schema consumer in this codebase).
 */
export async function consumeGamificationEvents(prisma: PrismaClient, event: InboundEvent): Promise<ConsumeEventResult> {
  if (!RECOGNIZED_EVENT_TYPES.includes(event.eventType as (typeof RECOGNIZED_EVENT_TYPES)[number])) {
    return { processed: false, recognized: false };
  }

  let result: ConsumptionResult;
  switch (event.eventType) {
    case "BadgeAwarded":
      result = await handleBadgeAwarded(prisma, event.payload as BadgeAwardedPayload, event.sourceEventId);
      break;
    case "StreakBroken":
      result = await handleStreakBroken(prisma, event.payload as StreakBrokenPayload, event.sourceEventId);
      break;
    default:
      return { processed: false, recognized: false };
  }

  return { processed: result.processed, recognized: true };
}
