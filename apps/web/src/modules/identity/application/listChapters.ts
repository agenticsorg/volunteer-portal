import type { PrismaClient } from "@prisma/client";

/**
 * The `identity-access-schema-api.md` contract's `Chapter[]` read shape —
 * backs `chapters.list`. Chapter directory data (name/city/country/status)
 * is not sensitive, so this read carries no `can()` gate, unlike
 * `chapters.create`/`chapters.assignLead`.
 */
export interface ChapterListItem {
  chapterId: string;
  name: string;
  slug: string;
  city: string;
  region: string | null;
  country: string;
  status: string;
  foundedAt: string | null;
  leadPersonId: string | null;
}

export interface ListChaptersInput {
  status?: "active" | "inactive";
}

export async function listChapters(
  prisma: PrismaClient,
  input: ListChaptersInput = {},
): Promise<ChapterListItem[]> {
  const chapters = await prisma.chapter.findMany({
    where: input.status ? { status: input.status } : undefined,
    orderBy: { name: "asc" },
  });

  return chapters.map((chapter) => ({
    chapterId: chapter.id,
    name: chapter.name,
    slug: chapter.slug,
    city: chapter.city,
    region: chapter.region,
    country: chapter.country,
    status: chapter.status,
    foundedAt: chapter.foundedAt ? chapter.foundedAt.toISOString().slice(0, 10) : null,
    leadPersonId: chapter.leadPersonId,
  }));
}
