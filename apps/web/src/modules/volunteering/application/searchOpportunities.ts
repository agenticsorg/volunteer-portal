import type { PrismaClient } from "@prisma/client";
import type { OpportunityListItem } from "./listOpportunities";

interface SearchRow {
  id: string;
  chapter_id: string | null;
  title: string;
  description: string;
  category: string;
  skills_required: string[];
  location_type: string;
  min_age: number;
  status: string;
  published_at: Date | null;
}

export interface SearchOpportunitiesInput {
  /** Free-text query, parsed with Postgres's `websearch_to_tsquery` (supports quoted phrases, `-exclude`, `OR`). */
  query: string;
  chapterId?: string;
  status?: "draft" | "published" | "closed" | "archived";
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * `opportunities`' full-text search (ADR-0017), against the
 * `search_vector` generated `tsvector` column (`title` weight A,
 * `category`/`skills_required` weight B, `description` weight C — see the
 * `..._add_volunteering_aggregates` migration). Not part of the API
 * Contract Sketch's own `opportunities.list` (which only filters by
 * `chapterId`/`status`/`category`, no free-text `query`), but required by
 * the Phase 3 completion bar ("opportunity search returns relevant results
 * via the tsvector column") — exposed as a distinct read alongside `list`
 * rather than folded into it, since `list`'s own contract is unchanged.
 *
 * `search_vector` is `Unsupported("tsvector")` in Prisma's schema (no
 * native scalar), so this can only be expressed via `$queryRaw` — same
 * constraint the schema's own comment documents for every other
 * `Unsupported()` column in this codebase (e.g. `admin.audit_log.ip_address`).
 * Results are ranked by `ts_rank` (best match first); defaults to
 * `status = 'published'`, matching `list`'s own public-read default.
 */
export async function searchOpportunities(
  prisma: PrismaClient,
  input: SearchOpportunitiesInput,
): Promise<OpportunityListItem[]> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const status = input.status ?? "published";

  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT
      id, chapter_id, title, description, category, skills_required,
      location_type, min_age, status, published_at
    FROM volunteering.opportunities
    WHERE search_vector @@ websearch_to_tsquery('english', ${input.query})
      AND status = ${status}::volunteering.opportunity_status
      AND (${input.chapterId ?? null}::text IS NULL OR chapter_id = ${input.chapterId ?? null})
    ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ${input.query})) DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    opportunityId: row.id,
    chapterId: row.chapter_id,
    title: row.title,
    description: row.description,
    category: row.category,
    skillsRequired: row.skills_required,
    locationType: row.location_type as OpportunityListItem["locationType"],
    minAge: row.min_age,
    status: row.status,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
  }));
}
