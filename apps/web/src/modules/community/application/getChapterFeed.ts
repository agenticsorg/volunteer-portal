import type { PrismaClient } from "@prisma/client";
import { queryFeedPage, type FeedPage, type FeedPagination } from "./feedRead";

export interface GetChapterFeedInput extends FeedPagination {
  chapterId: string;
}

/**
 * `getFeed` (docs/ddd/community-social.md's API Contract Sketch),
 * `scopeType: 'chapter'` branch — the chapter-scoped, reverse-chronological
 * feed query (Phase 6 Build item 4). Always filters `scope_type =
 * 'chapter' AND scope_id = chapterId`; there is no parameter on this
 * function that could widen a result set to org-wide or to a different
 * chapter than the one requested — see `getOrgFeed.ts` for the
 * deliberately separate org-wide query path, and `feedRead.ts`'s own doc
 * comment for why the two aren't unified behind one generic entry point.
 */
export async function getChapterFeed(prisma: PrismaClient, input: GetChapterFeedInput): Promise<FeedPage> {
  return queryFeedPage(prisma, { scopeType: "chapter", scopeId: input.chapterId }, input);
}
