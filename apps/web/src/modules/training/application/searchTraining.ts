import type { PrismaClient } from "@prisma/client";

interface SearchRow {
  kind: "course" | "module" | "video";
  course_id: string;
  module_id: string | null;
  title: string;
  snippet: string;
  rank: number;
}

export interface SearchTrainingInput {
  /** Free-text query, parsed with Postgres's `websearch_to_tsquery`. */
  query: string;
  limit?: number;
}

export interface TrainingSearchResult {
  kind: "course" | "module" | "video";
  courseId: string;
  moduleId: string | null;
  title: string;
  snippet: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * `searchTraining` — ADR-0017 full-text search "across course/module
 * titles and video transcript text" (Phase 4 build item 7 / completion
 * bar). Federated across the three generated `search_vector` columns this
 * schema owns (`training.course`, `training.module`, `training.video` —
 * see `..._add_training_aggregates` migration's own comment on why three
 * columns, not one, unlike `volunteering.opportunities`), composed here
 * as a single `UNION ALL` ranked by `ts_rank`, same "app-layer training
 * search procedure composes across all three" plan that migration's
 * comment describes. Scoped to `published` courses only — an unpublished
 * course's still-unapproved content has no business surfacing in learner
 * search results.
 *
 * `search_vector` is `Unsupported("tsvector")` in Prisma's schema (no
 * native scalar), so — same constraint as `volunteering`'s
 * `searchOpportunities` — this can only be expressed via `$queryRaw`.
 */
export async function searchTraining(prisma: PrismaClient, input: SearchTrainingInput): Promise<TrainingSearchResult[]> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT 'course' AS kind, c.id AS course_id, NULL::text AS module_id, c.title AS title,
           c.description AS snippet, ts_rank(c.search_vector, websearch_to_tsquery('english', ${input.query})) AS rank
    FROM training.course c
    WHERE c.search_vector @@ websearch_to_tsquery('english', ${input.query}) AND c.status = 'published'

    UNION ALL

    SELECT 'module' AS kind, m.course_id, m.id AS module_id, m.title AS title,
           '' AS snippet, ts_rank(m.search_vector, websearch_to_tsquery('english', ${input.query})) AS rank
    FROM training.module m
    JOIN training.course c ON c.id = m.course_id
    WHERE m.search_vector @@ websearch_to_tsquery('english', ${input.query}) AND c.status = 'published'

    UNION ALL

    SELECT 'video' AS kind, m.course_id, m.id AS module_id, m.title AS title,
           COALESCE(v.transcript_text, '') AS snippet,
           ts_rank(v.search_vector, websearch_to_tsquery('english', ${input.query})) AS rank
    FROM training.video v
    JOIN training.module m ON m.id = v.module_id
    JOIN training.course c ON c.id = m.course_id
    WHERE v.search_vector @@ websearch_to_tsquery('english', ${input.query}) AND c.status = 'published'

    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    kind: row.kind,
    courseId: row.course_id,
    moduleId: row.module_id,
    title: row.title,
    snippet: row.snippet.length > 240 ? `${row.snippet.slice(0, 240)}…` : row.snippet,
  }));
}
