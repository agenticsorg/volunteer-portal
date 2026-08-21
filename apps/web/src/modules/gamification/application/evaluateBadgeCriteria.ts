import { Prisma } from "@prisma/client";
import { type BadgeEvaluationContext, isCriteriaSatisfied, parseBadgeCriteria } from "../domain/badgeCriteria";
import { awardBadge } from "./awardBadge";

/**
 * EvaluateBadgeCriteria (docs/ddd/gamification.md, Key Use Case 3): runs
 * after a points/streak-affecting event is processed, checking every active
 * `Badge.criteria` against `ctx` (the person's state as of *this* event —
 * see `BadgeEvaluationContext`'s own doc comment for why this is a
 * lightweight context rather than a fresh full-history query) and awarding
 * any newly-satisfied, not-yet-awarded badge. Must be called from *inside*
 * the caller's own `prisma.$transaction`.
 *
 * Queries every active badge on each call (no attempt to pre-filter by
 * criteria type) — acceptable at this platform's documented scale (ADR-0009:
 * "chapters of tens to low hundreds of active members, not millions of
 * users"), same "small-scale, keep it simple" precedent as
 * `rebuildLeaderboardSnapshot.ts`.
 */
export async function evaluateBadgeCriteria(tx: Prisma.TransactionClient, ctx: BadgeEvaluationContext): Promise<void> {
  const activeBadges = await tx.badge.findMany({ where: { active: true } });

  for (const badge of activeBadges) {
    const criteria = parseBadgeCriteria(badge.criteria);
    if (!criteria || !isCriteriaSatisfied(criteria, ctx)) {
      continue;
    }
    await awardBadge(tx, { personId: ctx.personId, badgeId: badge.id, sourceEventId: ctx.sourceEventId });
  }
}
