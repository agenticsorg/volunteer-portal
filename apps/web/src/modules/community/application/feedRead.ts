import type { PrismaClient } from "@prisma/client";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

/**
 * One rendered row of a feed read (docs/ddd/community-social.md's
 * `FeedEntryDTO`, API Contract Sketch's `getFeed`). `post` is populated
 * only for `kind = 'post'` rows — every other `kind` renders straight from
 * its own stored, immutable `summary`/`payload` (FeedEntry invariant 1).
 */
export interface FeedEntryDTO {
  feedEntryId: string;
  kind: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  subjectPersonId: string;
  subjectDisplayName: string;
  sourceType: string;
  sourceId: string;
  summary: string;
  payload: unknown;
  createdAt: string;
  /**
   * Present only for `kind = 'post'` — resolved by joining `community.post`
   * live at read time (FeedEntry invariant 2), so a Post edit/hide
   * propagates to every subsequent feed read without this row ever being
   * re-projected or rewritten.
   */
  post: { body: string; attachments: unknown; authorId: string; authorDisplayName: string } | null;
}

export interface FeedPage {
  entries: FeedEntryDTO[];
  nextCursor: string | null;
}

export interface FeedPagination {
  /** Last-seen `feed_entry.id`, for keyset pagination (ULID order — ADR-0005). */
  cursor?: string;
  limit?: number;
}

/**
 * Shared row -> DTO mapping and FeedEntry invariant 2's live-join
 * resolution, private to this module's two feed queries (`getChapterFeed`/
 * `getOrgFeed`) — deliberately NOT a shared `getFeed(scopeType, scopeId)`
 * entry point, so there is no single code path an attacker-controlled
 * `scopeType` could take to blend chapter- and org-scoped results (Phase
 * 6's own completion bar: "a chapter feed must never leak another
 * chapter's restricted posts into results"; "an org-wide feed and a
 * chapter feed are both real, distinct query paths, never mixed").
 *
 * Native `kind = 'post'` rows whose underlying Post is no longer
 * `status = 'published'` (hidden/deleted) are filtered out of every read
 * here — the live-join half of FeedEntry invariant 1/2's "hidden by the
 * Post's own status ... no separate `feed_entry.hidden_at` write needed
 * there" (docs/ddd/community-social.md, Integration & Anti-Corruption
 * Notes). Every other `kind` is filtered by `feed_entry.hidden_at IS NULL`
 * directly, in the `WHERE` clause below.
 */
export async function queryFeedPage(
  prisma: PrismaClient,
  scope: { scopeType: "org" | "chapter"; scopeId: string | null },
  pagination: FeedPagination,
): Promise<FeedPage> {
  const limit = Math.min(Math.max(pagination.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.feedEntry.findMany({
    where: {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      hiddenAt: null,
      ...(pagination.cursor ? { id: { lt: pagination.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  // The raw (pre-visibility-filter) last row's id is the correct next
  // cursor regardless of how many rows `hidden`-Post filtering below
  // drops — pagination position tracks `feed_entry.id`, not the count of
  // rows actually rendered.
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  const postSourceIds = page.filter((row) => row.kind === "post").map((row) => row.sourceId);
  const posts = postSourceIds.length ? await prisma.post.findMany({ where: { id: { in: postSourceIds } } }) : [];
  const postById = new Map(posts.map((post) => [post.id, post]));

  const entries = page
    .filter((row) => {
      if (row.kind !== "post") return true;
      const post = postById.get(row.sourceId);
      return post !== undefined && post.status === "published";
    })
    .map((row) => {
      const post = row.kind === "post" ? postById.get(row.sourceId) ?? null : null;
      return {
        feedEntryId: row.id,
        kind: row.kind,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        subjectPersonId: row.subjectPersonId,
        subjectDisplayName: row.subjectDisplayName,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        summary: row.summary,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
        post: post
          ? {
              body: post.body,
              attachments: post.attachments,
              authorId: post.authorId,
              authorDisplayName: post.authorDisplayName,
            }
          : null,
      };
    });

  return { entries, nextCursor };
}
