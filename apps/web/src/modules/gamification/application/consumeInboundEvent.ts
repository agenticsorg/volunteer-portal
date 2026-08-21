import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  CourseCompletedPayload,
  HoursApprovedPayload,
  InboundEvent,
  InboundEventType,
  ModuleCompletedPayload,
} from "../domain/inboundEvents";
import { isInboundEventType } from "../domain/inboundEvents";
import { handleHoursApproved } from "./handleHoursApproved";
import { handleModuleCompleted } from "./handleModuleCompleted";
import { handleCourseCompleted } from "./handleCourseCompleted";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export interface ConsumeInboundEventResult {
  /** `true` iff this call's handler actually ran (a new event; not a redelivery, not an unrecognized type). */
  processed: boolean;
  /** `false` for an event whose `eventType` this consumer doesn't subscribe to (no-op, not an error). */
  recognized: boolean;
}

/**
 * Dispatches to the concrete, fully-typed `handle*` function for
 * `eventType` — a `switch`, not a `Record<string, ...>` lookup map, so each
 * handler keeps its own concrete payload type (`HoursApprovedPayload`, ...)
 * instead of widening to `unknown`/`any` for a shared map value type.
 */
function dispatchInboundEvent(
  tx: Prisma.TransactionClient,
  eventType: InboundEventType,
  payload: unknown,
  sourceEventId: string,
): Promise<void> {
  switch (eventType) {
    case "HoursApproved":
      return handleHoursApproved(tx, payload as HoursApprovedPayload, sourceEventId);
    case "ModuleCompleted":
      return handleModuleCompleted(tx, payload as ModuleCompletedPayload, sourceEventId);
    case "CourseCompleted":
      return handleCourseCompleted(tx, payload as CourseCompletedPayload, sourceEventId);
  }
}

/**
 * ConsumeInboundEvent (docs/ddd/gamification.md, Key Use Case 1) — the
 * generic, idempotent entry point for every subscribed event (`HoursApproved`,
 * `ModuleCompleted`, `CourseCompleted`) drained from `volunteering.domain_events`
 * / `training.domain_events` by a future infra-layer worker task (out of
 * scope for this phase's domain/application-layer stage — see this module's
 * `index.ts` header comment).
 *
 * Per ADR-0009 and this schema's own `gamification.processed_events` table
 * comment (keyed `(source_event_id, event_type)`, deliberately diverging
 * from `packages/outbox`'s generic `(consumer, event_id)` shape — this
 * context has exactly one logical consumer across both source schemas, not
 * several independent ones draining the same table, so a `consumer` column
 * would add a dimension it doesn't need), the idempotency check is the
 * *first* statement inside the transaction: `INSERT INTO
 * gamification.processed_events (source_event_id, event_type) VALUES (...)`.
 * A primary-key collision (this event already processed) throws `P2002`,
 * which rolls back the whole transaction — no ledger row, no badge, no
 * streak update, no re-published event — before the specific handler ever
 * runs. This is the exact mechanism docs/ddd/gamification.md's Integration &
 * Anti-Corruption Notes describes, expressed via Prisma's own
 * `create()` + unique-constraint-catch idiom (the same pattern every other
 * module in this codebase already uses for its own idempotency backstops —
 * see e.g. `volunteering/application/applyToShift.ts`) rather than
 * `packages/outbox`'s `drainOutbox()`, which cannot be pointed at this
 * table's different column shape unmodified.
 */
export async function consumeInboundEvent(
  prisma: PrismaClient,
  event: InboundEvent,
): Promise<ConsumeInboundEventResult> {
  if (!isInboundEventType(event.eventType)) {
    return { processed: false, recognized: false };
  }

  const eventType = event.eventType;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.gamificationProcessedEvent.create({
        data: { sourceEventId: event.sourceEventId, eventType },
      });
      await dispatchInboundEvent(tx, eventType, event.payload, event.sourceEventId);
    });
    return { processed: true, recognized: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      // Redelivery of an already-processed source event — no-op, matching
      // ADR-0009's "idempotent handlers are mandatory" guarantee.
      return { processed: false, recognized: true };
    }
    throw error;
  }
}
