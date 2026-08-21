import type { PrismaClient } from "@prisma/client";

interface SearchRow {
  id: string;
  author_id: string;
  author_display_name: string;
  body: string;
  scope_type: "org" | "chapter";
  scope_id: string | null;
  created_at: Date;
  rank: number;
}

export interface SearchPostsInput {
  /** Free-text query, parsed with Postgres's `websearch_to_tsquery`. */
  query: string;
  /**
   * Mandatory, matching `getChapterFeed`/`getOrgFeed`'s own "two real,
   * distinct query paths, never mixed" discipline (docs/ddd/
   * community-social.md's Scope definition; Phase 6's completion bar) —
   * there is no unscoped, cross-chapter search path any more than there is
   * an unscoped feed read.
   */
  scopeType: "org" | "chapter";
  scopeId: string | null;
  limit?: number;
}

export interface PostSearchResult {
  postId: string;
  authorId: string;
  authorDisplayName: string;
  /** Trimmed to a snippet — same 240-char cap as `training.searchTraining`'s own result shape. */
  snippet: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  createdAt: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_MAX_LENGTH = 240;

/**
 * `search` (Phase 6 build item 2: "Post full-text search using the
 * tsvector column", ADR-0017) — ranked full-text search over
 * `community.post.search_vector` (the `GENERATED ALWAYS AS
 * to_tsvector('english', body) STORED` column + `idx_post_search` GIN
 * index the schema stage already created). Not in docs/ddd/
 * community-social.md's own API Contract Sketch (that sketch predates this
 * build item being called out separately) — added here the same
 * "sibling to the sketch" way `trainingRouter.search` and
 * `volunteeringRouter.opportunities.search` were: required for build item
 * 2 to be anything more than an unused database column.
 *
 * Scoped to `status = 'published'` only, same visibility rule
 * `queryFeedPage` applies to native `kind = 'post'` feed rows — a
 * hidden/deleted Post has no business surfacing in search results either.
 *
 * `search_vector` is `Unsupported("tsvector")` in Prisma's schema (no
 * native scalar), so — same constraint as `training`'s/`volunteering`'s
 * own full-text search — this can only be expressed via `$queryRaw`.
 */
export async function searchPosts(prisma: PrismaClient, input: SearchPostsInput): Promise<PostSearchResult[]> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT id, author_id, author_display_name, body, scope_type, scope_id, created_at,
           ts_rank(search_vector, websearch_to_tsquery('english', ${input.query})) AS rank
    FROM community.post
    WHERE search_vector @@ websearch_to_tsquery('english', ${input.query})
      AND status = 'published'
      AND scope_type = ${input.scopeType}::community.scope_type
      AND scope_id IS NOT DISTINCT FROM ${input.scopeId}
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    postId: row.id,
    authorId: row.author_id,
    authorDisplayName: row.author_display_name,
    snippet: row.body.length > SNIPPET_MAX_LENGTH ? `${row.body.slice(0, SNIPPET_MAX_LENGTH)}…` : row.body,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    createdAt: row.created_at.toISOString(),
  }));
}
