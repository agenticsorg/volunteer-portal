import type { PrismaClient } from "@prisma/client";
import type { StreakStatus } from "../domain/streakRules";

export interface BadgeAwardDTO {
  badgeAwardId: string;
  awardedAt: Date;
  badge: {
    id: string;
    slug: string;
    name: string;
    description: string;
    iconUrl: string | null;
    isPublic: boolean;
    /** `false` once the badge definition has been retired — the award itself still appears here regardless (see this function's own doc comment). */
    active: boolean;
  };
}

export interface StreakDTO {
  activityType: string;
  currentLength: number;
  longestLength: number;
  status: StreakStatus;
  freezesAvailable: number;
}

export interface PersonGamificationProfile {
  totalPoints: bigint;
  badges: BadgeAwardDTO[];
  streaks: StreakDTO[];
}

/**
 * GetPersonGamificationProfile (docs/ddd/gamification.md, Key Use Case 8):
 * a person's `PointsBalance`, `BadgeAward` list (with badge detail), and
 * active `Streak`s, for profile/portfolio display — this is the read
 * `community` (a later phase) is documented to call synchronously through
 * this module's `index.ts` rather than duplicating badge/points data into
 * its own schema (Integration & Anti-Corruption Notes' one deliberate
 * exception to "modules only talk via events").
 *
 * Badges are joined via `include`, not filtered by `badge.active` — this is
 * the load-bearing half of the Phase 5 completion bar ("a badge, once
 * awarded, remains visible on a person's profile even after the badge's own
 * definition is later deactivated"): `BadgeAward` rows are never removed or
 * hidden when `Badge.active` flips to `false` (see `Badge`'s own doc comment
 * in schema.prisma), and this query surfaces every award regardless.
 */
export async function getPersonGamificationProfile(
  prisma: PrismaClient,
  personId: string,
): Promise<PersonGamificationProfile> {
  const [balance, badgeAwards, streaks] = await Promise.all([
    prisma.pointsBalance.findUnique({ where: { personId } }),
    prisma.badgeAward.findMany({
      where: { personId },
      include: { badge: true },
      orderBy: { awardedAt: "desc" },
    }),
    prisma.streak.findMany({ where: { personId } }),
  ]);

  return {
    totalPoints: balance?.totalPoints ?? BigInt(0),
    badges: badgeAwards.map((award) => ({
      badgeAwardId: award.id,
      awardedAt: award.awardedAt,
      badge: {
        id: award.badge.id,
        slug: award.badge.slug,
        name: award.badge.name,
        description: award.badge.description,
        iconUrl: award.badge.iconUrl,
        isPublic: award.badge.isPublic,
        active: award.badge.active,
      },
    })),
    streaks: streaks.map((s) => ({
      activityType: s.activityType,
      currentLength: s.currentLength,
      longestLength: s.longestLength,
      status: s.status,
      freezesAvailable: s.freezesAvailable,
    })),
  };
}
