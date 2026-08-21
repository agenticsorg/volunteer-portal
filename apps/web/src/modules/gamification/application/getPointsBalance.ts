import type { PrismaClient } from "@prisma/client";

export interface PointsBalanceDTO {
  totalPoints: bigint;
  updatedAt: Date;
}

/**
 * `getMyPointsBalance` (docs/ddd/gamification.md's API Contract Sketch) — the
 * `PointsBalance` projection alone, for the lightweight "my points" display
 * that doesn't need the full `getPersonGamificationProfile` bundle.
 * `PointsBalance` is always re-derivable from `points_ledger_entry`
 * (`SUM(points) GROUP BY person_id`) — this read serves the maintained
 * projection, never a second source of truth.
 */
export async function getPointsBalance(prisma: PrismaClient, personId: string): Promise<PointsBalanceDTO> {
  const balance = await prisma.pointsBalance.findUnique({ where: { personId } });
  return { totalPoints: balance?.totalPoints ?? BigInt(0), updatedAt: balance?.updatedAt ?? new Date(0) };
}
