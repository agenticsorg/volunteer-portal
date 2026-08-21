import type { PrismaClient } from "@prisma/client";
import { queryFeedPage, type FeedPage, type FeedPagination } from "./feedRead";

/**
 * `getFeed` (docs/ddd/community-social.md's API Contract Sketch),
 * `scopeType: 'org'` branch — the org-wide, reverse-chronological feed
 * query (Phase 6 Build item 4). Always filters `scope_type = 'org' AND
 * scope_id IS NULL`; this function takes no chapter parameter at all, so
 * there is no way for a chapter-restricted post to reach this path — see
 * `getChapterFeed.ts` for the deliberately separate chapter-scoped query.
 */
export async function getOrgFeed(prisma: PrismaClient, input: FeedPagination = {}): Promise<FeedPage> {
  return queryFeedPage(prisma, { scopeType: "org", scopeId: null }, input);
}
