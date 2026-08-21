import type { PrismaClient } from "@prisma/client";
import type { HoursApprovedPayload, InboundEvent } from "../domain/inboundEvents";
import { handleHoursApproved } from "./handlers/volunteering/hoursApproved";
import type { ConsumptionResult } from "./idempotentConsumption";

const RECOGNIZED_EVENT_TYPES = ["HoursApproved"] as const;

export interface ConsumeEventResult {
  /** `true` iff this call's handler actually ran (a new event; not a redelivery, not an unrecognized type). */
  processed: boolean;
  /** `false` for an event whose `eventType` this consumer doesn't subscribe to (no-op, not an error — a `volunteering.domain_events` row this context doesn't care about). */
  recognized: boolean;
}

/**
 * `ConsumeVolunteeringEvents` — one of this context's five per-source-schema
 * consumer jobs (docs/plans/implementation-plan.md's Phase 8 Build item 1;
 * `notifications.processed_events`' own schema comment: "one per source
 * schema listed in the Consumed event table, not one per event type").
 * Dispatched by a future infra-layer graphile-worker task (out of scope
 * for this stage — same split every other module's `index.ts` header
 * already documents for its own event-relay worker) that polls
 * `volunteering.domain_events` and calls this function once per
 * undispatched row. A `switch`, not a `Record<string, ...>` lookup map, so
 * `handleHoursApproved` keeps its own concrete `HoursApprovedPayload`
 * parameter type — same shape `gamification`'s/`community`'s own
 * `consumeInboundEvent.ts` dispatchers already use.
 */
export async function consumeVolunteeringEvents(prisma: PrismaClient, event: InboundEvent): Promise<ConsumeEventResult> {
  if (!RECOGNIZED_EVENT_TYPES.includes(event.eventType as (typeof RECOGNIZED_EVENT_TYPES)[number])) {
    return { processed: false, recognized: false };
  }

  let result: ConsumptionResult;
  switch (event.eventType) {
    case "HoursApproved":
      result = await handleHoursApproved(prisma, event.payload as HoursApprovedPayload, event.sourceEventId);
      break;
    default:
      return { processed: false, recognized: false };
  }

  return { processed: result.processed, recognized: true };
}
