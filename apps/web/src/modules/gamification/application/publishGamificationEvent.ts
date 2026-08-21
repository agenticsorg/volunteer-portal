import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { attachRequestMetadata, getRequestId } from "@volunteer-portal/observability";

/**
 * Writes one row to this context's own transactional outbox
 * (`gamification.domain_events`, ADR-0009) — always called from *inside*
 * the same `prisma.$transaction` as the state change it announces, same
 * "write the event in the same transaction as the write it describes" shape
 * as `volunteering`'s `approveHours.ts` / `training`'s `moduleCompletion.ts`.
 * Downstream, `notifications` and `community` drain this table (a later
 * phase's consumer) for `PointsAwarded`, `BadgeAwarded`, `StreakExtended`,
 * `StreakFrozen`, and `StreakBroken`.
 *
 * ADR-0013 §"Correlation": stamps the current request's `requestId` onto
 * `payload._meta.requestId` before writing — see `publishCommunityEvent.ts`'s
 * matching doc comment for the full rationale.
 */
export interface GamificationEventInput {
  eventType: "PointsAwarded" | "BadgeAwarded" | "StreakExtended" | "StreakFrozen" | "StreakBroken";
  aggregateType: "PointsLedgerEntry" | "BadgeAward" | "Streak";
  aggregateId: string;
  payload: Prisma.InputJsonValue;
}

export async function publishGamificationEvent(
  tx: Prisma.TransactionClient,
  event: GamificationEventInput,
): Promise<void> {
  await tx.gamificationDomainEvent.create({
    data: {
      id: newId(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: attachRequestMetadata(event.payload, getRequestId()),
    },
  });
}
