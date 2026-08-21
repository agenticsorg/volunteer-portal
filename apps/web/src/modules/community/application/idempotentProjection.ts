import { Prisma, type PrismaClient } from "@prisma/client";
import type { InboundEventType } from "../domain/inboundEvents";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export interface ProjectionResult {
  /** `true` iff `fn` actually ran (a new event; not a redelivery). */
  processed: boolean;
}

/**
 * The one idempotency mechanism every `handle*` consumer in this module
 * uses (ADR-0009; docs/ddd/community-social.md's Integration &
 * Anti-Corruption Notes: "Every handler is wrapped in one DB transaction
 * that (a) checks/reserves `community.processed_events.id = event.id` ...
 * and (b) the `feed_entry` unique indexes ... as a second line of
 * defense"). `community.processed_events` is keyed by a single `id`
 * column (the origin event's own id) — see that table's own Prisma-schema
 * comment for why this deliberately diverges from `packages/outbox`'s
 * generic `(consumer, event_id)` template — so a plain `create()` +
 * unique-violation-catch (mirroring `gamification`'s own
 * `consumeInboundEvent.ts`) is the whole mechanism.
 *
 * `fn` receives the transaction and should perform ONLY the local
 * `community` schema write(s) the event projects to (typically a single
 * `feed_entry.create`) — any cross-context Open Host Service read needed
 * to build that write's data (`identity.getPersonSummary`, `gamification.
 * getPersonGamificationProfile`, ...) must already be resolved by the
 * caller *before* invoking this helper, since those reads need a plain
 * `PrismaClient`, not a `Prisma.TransactionClient`.
 */
export async function recordProcessedEventAndProject(
  prisma: PrismaClient,
  event: { id: string; sourceContext: string; eventType: InboundEventType },
  fn: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<ProjectionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.communityProcessedEvent.create({
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
