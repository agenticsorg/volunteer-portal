import type { PrismaClient } from "@prisma/client";
import type {
  BadgeAwardedPayload,
  CourseCompletedPayload,
  HoursApprovedPayload,
  InboundEvent,
  InboundEventType,
  StreakExtendedPayload,
} from "../domain/inboundEvents";
import { isInboundEventType } from "../domain/inboundEvents";
import { handleBadgeAwarded } from "./handleBadgeAwarded";
import { handleHoursApproved } from "./handleHoursApproved";
import { handleCourseCompleted } from "./handleCourseCompleted";
import { handleStreakExtended } from "./handleStreakExtended";
import type { ProjectionResult } from "./idempotentProjection";

export interface ConsumeInboundEventResult {
  /** `true` iff this call's handler actually ran (a new event; not a redelivery, not an unrecognized type). */
  processed: boolean;
  /** `false` for an event whose `eventType` this consumer doesn't subscribe to (no-op, not an error). */
  recognized: boolean;
}

/**
 * Dispatches to the concrete, fully-typed `handle*` function for
 * `eventType` — a `switch`, not a `Record<string, ...>` lookup map, so
 * each handler keeps its own concrete payload type (`BadgeAwardedPayload`,
 * ...) instead of widening to `unknown`/`any` for a shared map value type
 * (same shape as `gamification`'s own `consumeInboundEvent.ts`).
 */
function dispatchInboundEvent(
  prisma: PrismaClient,
  eventType: InboundEventType,
  payload: unknown,
  sourceEventId: string,
): Promise<ProjectionResult> {
  switch (eventType) {
    case "BadgeAwarded":
      return handleBadgeAwarded(prisma, payload as BadgeAwardedPayload, sourceEventId);
    case "HoursApproved":
      return handleHoursApproved(prisma, payload as HoursApprovedPayload, sourceEventId);
    case "CourseCompleted":
      return handleCourseCompleted(prisma, payload as CourseCompletedPayload, sourceEventId);
    case "StreakExtended":
      return handleStreakExtended(prisma, payload as StreakExtendedPayload, sourceEventId);
  }
}

/**
 * ConsumeInboundEvent — the generic, idempotent entry point for every
 * event this context subscribes to (`BadgeAwarded`/`StreakExtended` from
 * `gamification.domain_events`, `HoursApproved` from
 * `volunteering.domain_events`, `CourseCompleted` from
 * `training.domain_events`), drained by a future infra-layer worker task
 * (out of scope for this stage — see this module's `index.ts` header
 * comment, same split as `gamification`'s own consumer).
 *
 * Unlike `gamification`'s `consumeInboundEvent` (which performs the
 * `processed_events` idempotency check itself, as the transaction's first
 * statement, before dispatching), each `handle*` function here owns its
 * own idempotency-guarded transaction (`idempotentProjection.ts`) — because
 * every handler in this module first needs a cross-context Open Host
 * Service read (`identity.getPersonSummary`, and one of
 * `gamification.getPersonGamificationProfile` / `volunteering.
 * getOpportunityById` / `training.getCourseById`) to build the `FeedEntry`
 * it will write, and those reads require a plain `PrismaClient`, not a
 * `Prisma.TransactionClient` — so the read has to happen before any
 * transaction opens. This function stays a thin, type-checking dispatcher;
 * every handler is unconditionally safe under at-least-once redelivery on
 * its own.
 */
export async function consumeInboundEvent(
  prisma: PrismaClient,
  event: InboundEvent,
): Promise<ConsumeInboundEventResult> {
  if (!isInboundEventType(event.eventType)) {
    return { processed: false, recognized: false };
  }

  const { processed } = await dispatchInboundEvent(prisma, event.eventType, event.payload, event.sourceEventId);
  return { processed, recognized: true };
}
