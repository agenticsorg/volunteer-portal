import type { PrismaClient } from "@prisma/client";
import type { StreakDTO } from "./getPersonGamificationProfile";

/** `getMyStreak` (docs/ddd/gamification.md's API Contract Sketch) — a single person/activityType `Streak`, or `null` if none exists yet. */
export async function getMyStreak(
  prisma: PrismaClient,
  personId: string,
  activityType: string,
): Promise<StreakDTO | null> {
  const streak = await prisma.streak.findUnique({
    where: { personId_activityType: { personId, activityType } },
  });
  if (!streak) return null;
  return {
    activityType: streak.activityType,
    currentLength: streak.currentLength,
    longestLength: streak.longestLength,
    status: streak.status,
    freezesAvailable: streak.freezesAvailable,
  };
}
