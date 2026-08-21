import type { PrismaClient } from "@prisma/client";
import { assertScopedLeaderboard, type LeaderboardScope } from "../domain/leaderboardScope";

export interface GetLeaderboardInput {
  scope: LeaderboardScope;
  /** Defaults to the most recently computed snapshot batch for this scope. */
  periodStart?: Date;
}

export interface LeaderboardEntry {
  personId: string;
  rank: number;
  points: number;
}

export interface LeaderboardResult {
  scope: LeaderboardScope;
  periodStart: Date | null;
  periodEnd: Date | null;
  entries: LeaderboardEntry[];
}

/**
 * GetLeaderboard (docs/ddd/gamification.md, Key Use Case 7): query-only,
 * reads `leaderboard_snapshot` for a required, validated `(scopeType,
 * scopeId)` pair. `scope` is a required parameter (not optional) precisely
 * so no call site can omit it — combined with `assertScopedLeaderboard`'s
 * runtime check, this is the "the API layer rejects any request that omits
 * a scope" half of the doc's API Contract Sketch, expressed at this
 * application-layer choke point every future API adapter must call through.
 */
export async function getLeaderboard(prisma: PrismaClient, input: GetLeaderboardInput): Promise<LeaderboardResult> {
  assertScopedLeaderboard(input.scope);

  let periodStart = input.periodStart;

  if (!periodStart) {
    const latest = await prisma.leaderboardSnapshot.findFirst({
      where: { scopeType: input.scope.scopeType, scopeId: input.scope.scopeId },
      orderBy: { periodStart: "desc" },
      select: { periodStart: true },
    });
    if (!latest) {
      return { scope: input.scope, periodStart: null, periodEnd: null, entries: [] };
    }
    periodStart = latest.periodStart;
  }

  const rows = await prisma.leaderboardSnapshot.findMany({
    where: { scopeType: input.scope.scopeType, scopeId: input.scope.scopeId, periodStart },
    orderBy: { rank: "asc" },
  });

  return {
    scope: input.scope,
    periodStart: rows[0]?.periodStart ?? periodStart,
    periodEnd: rows[0]?.periodEnd ?? null,
    entries: rows.map((r) => ({ personId: r.personId, rank: r.rank, points: Number(r.points) })),
  };
}
