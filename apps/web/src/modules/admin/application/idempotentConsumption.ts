import { Prisma, type PrismaClient } from "@prisma/client";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export interface ConsumptionResult {
  /** `true` iff `fn` actually ran (a new event; not a redelivery). */
  processed: boolean;
}

/**
 * The idempotency mechanism `consumeIdentityDsarEvents.ts` uses (ADR-0009)
 * — same single-consumer-per-source-schema shape
 * `modules/notifications/application/idempotentConsumption.ts` already
 * established (see that file's own header comment for the full rationale
 * of why a dedicated `(id)`-keyed ledger, not `packages/outbox`'s generic
 * `(consumer, event_id)` template): `admin` has exactly one logical
 * external consumer this phase (identity's DSAR completion events), not
 * several independent subscribers draining the same table.
 *
 * The ledger insert and `fn`'s own writes (the correlated `ExportJob`
 * update, this context's own `ExportJobCompleted`/`ExportJobFailed`
 * event, and its `recordAuditEvent` call) commit atomically in one
 * transaction — a redelivered `identity.domain_events` row rolls back to
 * a no-op via the unique-constraint catch below, never double-applying a
 * DSAR completion to an already-`completed`/`failed` `ExportJob`.
 */
export async function recordProcessedEventAndHandle(
  prisma: PrismaClient,
  event: { id: string; sourceContext: string; eventType: string },
  fn: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<ConsumptionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.adminProcessedEvent.create({
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
