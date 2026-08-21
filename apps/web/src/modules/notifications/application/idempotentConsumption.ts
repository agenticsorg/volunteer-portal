import { Prisma, type PrismaClient } from "@prisma/client";
import type { SourceContext } from "../domain/inboundEvents";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export interface ConsumptionResult {
  /** `true` iff `fn` actually ran (a new event; not a redelivery). */
  processed: boolean;
}

/**
 * The one idempotency mechanism every `consume*Events` job in this module
 * uses (ADR-0009). `notifications.processed_events`
 * (`NotificationsProcessedEvent`) is keyed by a single `id` column (the
 * origin `domain_events.id`, a ULID, already globally unique on its own) —
 * see that table's own Prisma-schema comment for why this deliberately
 * diverges from `packages/outbox`'s generic `(consumer, event_id)`
 * template: this context has exactly one logical consumer per source
 * schema (five jobs, one per source schema, not one per event type), not
 * several independent consumers draining the same table. Same shape as
 * `gamification`'s own `consumeInboundEvent.ts` and `community`'s
 * `idempotentProjection.ts`.
 *
 * The ledger insert and `fn`'s own writes (`QueueNotification`'s
 * `notification`/`delivery_attempt`/`domain_events` rows, including the
 * zero-row-created "suppressed" outcome) commit atomically in one
 * transaction — a redelivered event rolls back to a no-op via the
 * unique-constraint catch below, never double-queuing a notification.
 */
export async function recordProcessedEventAndHandle(
  prisma: PrismaClient,
  event: { id: string; sourceContext: SourceContext; eventType: string },
  fn: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<ConsumptionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.notificationsProcessedEvent.create({
        data: { id: event.id, sourceContext: event.sourceContext, eventType: event.eventType },
      });
      await fn(tx);
    });
    return { processed: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      // Redelivery of an already-processed source event — no-op, matching
      // ADR-0009's "idempotent handlers are mandatory" guarantee.
      return { processed: false };
    }
    throw error;
  }
}
