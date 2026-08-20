import type { PrismaClient } from "@prisma/client";

/** `opportunities.list`'s per-item shape (API Contract Sketch). */
export interface OpportunityListItem {
  opportunityId: string;
  chapterId: string | null;
  title: string;
  description: string;
  category: string;
  skillsRequired: string[];
  locationType: "in_person" | "remote" | "hybrid";
  minAge: number;
  status: string;
  publishedAt: string | null;
}

export interface ListOpportunitiesInput {
  chapterId?: string;
  status?: "draft" | "published" | "closed" | "archived";
  category?: string;
  cursor?: string;
  limit?: number;
}

export interface ListOpportunitiesResult {
  items: OpportunityListItem[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function toListItem(opportunity: {
  id: string;
  chapterId: string | null;
  title: string;
  description: string;
  category: string;
  skillsRequired: string[];
  locationType: string;
  minAge: number;
  status: string;
  publishedAt: Date | null;
}): OpportunityListItem {
  return {
    opportunityId: opportunity.id,
    chapterId: opportunity.chapterId,
    title: opportunity.title,
    description: opportunity.description,
    category: opportunity.category,
    skillsRequired: opportunity.skillsRequired,
    locationType: opportunity.locationType as OpportunityListItem["locationType"],
    minAge: opportunity.minAge,
    status: opportunity.status,
    publishedAt: opportunity.publishedAt ? opportunity.publishedAt.toISOString() : null,
  };
}

/**
 * `opportunities.list` (API Contract Sketch) — a public, unauthenticated
 * read (published opportunities are the platform's own marketing surface),
 * defaulting to `status: 'published'` the same way the contract sketch's
 * own `z.enum(['published']).default('published')` does. ULID ordering
 * (newest-first, `id desc`) doubles as the cursor field since ULIDs are
 * chronologically sortable by construction (ADR-0005) — no separate
 * `createdAt` cursor column needed.
 */
export async function listOpportunities(
  prisma: PrismaClient,
  input: ListOpportunitiesInput = {},
): Promise<ListOpportunitiesResult> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const opportunities = await prisma.opportunity.findMany({
    where: {
      status: input.status ?? "published",
      chapterId: input.chapterId,
      category: input.category,
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = opportunities.length > limit;
  const page = hasMore ? opportunities.slice(0, limit) : opportunities;

  return {
    items: page.map(toListItem),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** `opportunities.getById` (API Contract Sketch) — same visibility as `list`. */
export async function getOpportunityById(
  prisma: PrismaClient,
  opportunityId: string,
): Promise<OpportunityListItem | null> {
  const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
  return opportunity ? toListItem(opportunity) : null;
}
