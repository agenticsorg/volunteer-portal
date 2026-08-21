import type { PrismaClient } from "@prisma/client";

export interface BadgeDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  iconUrl: string | null;
  isPublic: boolean;
  active: boolean;
}

export interface ListBadgesInput {
  /** Defaults to `true` (docs/ddd/gamification.md's API Contract Sketch) — retired badges are still awarded-and-visible on profiles, but not surfaced in the general catalog by default. */
  activeOnly?: boolean;
}

/** `listBadges` (docs/ddd/gamification.md's API Contract Sketch) — the badge definition catalog. */
export async function listBadges(prisma: PrismaClient, input: ListBadgesInput = {}): Promise<BadgeDTO[]> {
  const activeOnly = input.activeOnly ?? true;
  const badges = await prisma.badge.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { name: "asc" },
  });
  return badges.map((b) => ({
    id: b.id,
    slug: b.slug,
    name: b.name,
    description: b.description,
    iconUrl: b.iconUrl,
    isPublic: b.isPublic,
    active: b.active,
  }));
}
