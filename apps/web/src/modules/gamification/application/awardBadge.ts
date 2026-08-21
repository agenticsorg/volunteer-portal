import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { publishGamificationEvent } from "./publishGamificationEvent";

export interface AwardBadgeInput {
  personId: string;
  badgeId: string;
  /** Traceability — which event caused this award; `null`/omitted for a staff-granted (`adminAwardBadge`) award. */
  sourceEventId?: string | null;
}

export interface AwardBadgeResult {
  awarded: boolean;
  badgeAwardId: string | null;
}

/**
 * AwardBadge (docs/ddd/gamification.md, Key Use Case 4): "an idempotent
 * insert into `badge_award` (`ON CONFLICT (person_id, badge_id) DO
 * NOTHING`)" — the doc's own literal SQL idiom, used here verbatim via
 * `$queryRaw` rather than Prisma's `create()` + catch-P2002. That
 * alternative was tried first and is a real bug, not just a style choice:
 * a duplicate-key `INSERT` failing inside a Postgres transaction leaves the
 * *whole* transaction aborted (Postgres error `25P02`) even once the JS
 * exception is caught, so any statement a caller runs afterwards in the
 * same `prisma.$transaction` (e.g. `adminAwardBadge`'s own
 * `recordAuditEvent` call right after this one) blows up with "current
 * transaction is aborted." `INSERT ... ON CONFLICT DO NOTHING` never raises
 * on the duplicate — the conflict is resolved inside the one statement — so
 * the surrounding transaction stays healthy for whatever runs next.
 * `packages/outbox/src/drainOutbox.ts`'s `processed_events` insert uses the
 * identical `... RETURNING <col>` / empty-rows-means-conflict idiom.
 *
 * Publishes `BadgeAwarded` only if a row was actually inserted. Must be
 * called from *inside* the caller's own `prisma.$transaction`.
 */
export async function awardBadge(tx: Prisma.TransactionClient, input: AwardBadgeInput): Promise<AwardBadgeResult> {
  const badgeAwardId = newId();

  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO gamification.badge_award (id, person_id, badge_id, source_event_id)
    VALUES (${badgeAwardId}, ${input.personId}, ${input.badgeId}, ${input.sourceEventId ?? null})
    ON CONFLICT (person_id, badge_id) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    return { awarded: false, badgeAwardId: null };
  }

  const awardedAt = new Date();
  await publishGamificationEvent(tx, {
    eventType: "BadgeAwarded",
    aggregateType: "BadgeAward",
    aggregateId: badgeAwardId,
    payload: {
      personId: input.personId,
      badgeId: input.badgeId,
      badgeAwardId,
      awardedAt: awardedAt.toISOString(),
    },
  });

  return { awarded: true, badgeAwardId };
}
