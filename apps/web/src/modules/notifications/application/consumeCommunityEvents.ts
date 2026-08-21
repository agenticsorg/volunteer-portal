import type { PrismaClient } from "@prisma/client";
import type { InboundEvent, KudosGivenPayload, MentorshipStartedPayload } from "../domain/inboundEvents";
import { handleKudosGiven } from "./handlers/community/kudosGiven";
import { handleMentorshipStarted } from "./handlers/community/mentorshipStarted";
import type { ConsumptionResult } from "./idempotentConsumption";
import type { ConsumeEventResult } from "./consumeVolunteeringEvents";

const RECOGNIZED_EVENT_TYPES = ["KudosGiven", "MentorshipStarted"] as const;

/**
 * `ConsumeCommunityEvents` — see `consumeVolunteeringEvents.ts`'s own doc
 * comment for the shared design rationale. Handles `community.domain_events`'
 * `KudosGiven` and `MentorshipStarted` (`PostCreated`/`TeamCreated`/
 * `TeamJoined`/`MentorshipRequested`/`MentionCreated` are also published by
 * `community` but are not in this stage's Build list — normal
 * `recognized: false` no-ops here).
 */
export async function consumeCommunityEvents(prisma: PrismaClient, event: InboundEvent): Promise<ConsumeEventResult> {
  if (!RECOGNIZED_EVENT_TYPES.includes(event.eventType as (typeof RECOGNIZED_EVENT_TYPES)[number])) {
    return { processed: false, recognized: false };
  }

  let result: ConsumptionResult;
  switch (event.eventType) {
    case "KudosGiven":
      result = await handleKudosGiven(prisma, event.payload as KudosGivenPayload, event.sourceEventId);
      break;
    case "MentorshipStarted":
      result = await handleMentorshipStarted(prisma, event.payload as MentorshipStartedPayload, event.sourceEventId);
      break;
    default:
      return { processed: false, recognized: false };
  }

  return { processed: result.processed, recognized: true };
}
