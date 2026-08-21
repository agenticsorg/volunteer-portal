import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { publishGamificationEvent } from "./publishGamificationEvent";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

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
 * AwardBadge (docs/ddd/gamification.md, Key Use Case 4): an idempotent
 * insert into `badge_award` — `BadgeAward` invariant ("exactly one
 * `BadgeAward` per `(personId, badgeId)`") makes re-processing the same
 * qualifying event a second time a no-op, not a duplicate award. Publishes
 * `BadgeAwarded` only if a row was actually inserted. Must be called from
 * *inside* the caller's own `prisma.$transaction`.
 */
export async function awardBadge(tx: Prisma.TransactionClient, input: AwardBadgeInput): Promise<AwardBadgeResult> {
  const badgeAwardId = newId();

  try {
    await tx.badgeAward.create({
      data: {
        id: badgeAwardId,
        personId: input.personId,
        badgeId: input.badgeId,
        sourceEventId: input.sourceEventId ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      return { awarded: false, badgeAwardId: null };
    }
    throw error;
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
