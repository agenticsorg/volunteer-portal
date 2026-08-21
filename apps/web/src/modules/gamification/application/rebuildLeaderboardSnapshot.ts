import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { assertScopedLeaderboard, type LeaderboardScope } from "../domain/leaderboardScope";

export interface RebuildLeaderboardSnapshotInput {
  scope: LeaderboardScope;
  /**
   * The `personId`s who are members of this Team/Challenge as of the
   * rebuild — supplied by the caller, never queried here. `community` (a
   * later phase) owns team/challenge membership; per ADR-0001 this context
   * never queries another schema's tables directly, so it has no way to
   * discover membership on its own. A future `community`-triggered job
   * calls this with the membership list it already has.
   */
  memberPersonIds: readonly string[];
  periodStart: Date;
  periodEnd: Date;
}

/**
 * RebuildLeaderboardSnapshot (docs/ddd/gamification.md, Key Use Case 6):
 * recomputes `leaderboard_snapshot` rows for one `LeaderboardScope` and time
 * window directly from `points_ledger_entry` — never from
 * `leaderboard_snapshot` itself ("a cache of a cache would be a bug," per
 * that use case's own doc comment). Every member of `memberPersonIds` gets a
 * ranked row even at 0 points, so the leaderboard shows the whole
 * team/challenge roster, not just people who have ever earned points.
 * Standard competition ranking (ties share a rank; the next distinct score
 * skips ahead by the tie's size).
 */
export async function rebuildLeaderboardSnapshot(
  prisma: PrismaClient,
  input: RebuildLeaderboardSnapshotInput,
): Promise<void> {
  assertScopedLeaderboard(input.scope);

  if (input.memberPersonIds.length === 0) {
    return;
  }

  const totals = await prisma.pointsLedgerEntry.groupBy({
    by: ["personId"],
    where: {
      personId: { in: [...input.memberPersonIds] },
      createdAt: { gte: input.periodStart, lt: input.periodEnd },
    },
    _sum: { points: true },
  });
  const totalsByPerson = new Map(totals.map((t) => [t.personId, t._sum.points ?? 0]));

  const ranked = [...new Set(input.memberPersonIds)]
    .map((personId) => ({ personId, points: totalsByPerson.get(personId) ?? 0 }))
    .sort((a, b) => b.points - a.points);

  await prisma.$transaction(async (tx) => {
    await tx.leaderboardSnapshot.deleteMany({
      where: { scopeType: input.scope.scopeType, scopeId: input.scope.scopeId, periodStart: input.periodStart },
    });

    let rank = 0;
    let previousPoints: number | null = null;

    for (const [index, entry] of ranked.entries()) {
      if (previousPoints === null || entry.points !== previousPoints) {
        rank = index + 1;
      }
      previousPoints = entry.points;

      await tx.leaderboardSnapshot.create({
        data: {
          id: newId(),
          scopeType: input.scope.scopeType,
          scopeId: input.scope.scopeId,
          personId: entry.personId,
          rank,
          points: entry.points,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        },
      });
    }
  });
}
