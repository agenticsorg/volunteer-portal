import { Prisma, type PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { queryModerationHistory, type ModerationHistoryEntryDto } from "@/modules/moderation";
import { ForbiddenActionError } from "../domain/errors";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** docs/ddd/admin-reporting.md's `AuditLogQuery` — shared filter shape across both read paths. */
export interface AuditLogQueryFilters {
  actorId?: string;
  actionPrefix?: string;
  resourceType?: string;
  resourceId?: string;
  occurredAfter?: Date;
  occurredBefore?: Date;
  scopeId?: string;
  cursor?: string;
  limit?: number;
}

export type AuditLogSearchSource = "platform" | "moderation_history" | "both";

/**
 * One row of `SearchAuditLog`'s unioned result set, tagged so a caller
 * (the admin console) can tell a summarized `admin.audit_log` entry apart
 * from the fuller, evidence-linked `moderation` detail — docs/ddd/
 * admin-reporting.md Key Use Case 6's own literal requirement.
 */
export type AuditLogSearchEntry =
  | {
      source: "platform_summary";
      id: string;
      occurredAt: string;
      actorId: string | null;
      actorType: string;
      action: string;
      resourceType: string;
      resourceId: string;
      scopeType: string | null;
      scopeId: string | null;
      metadata: unknown;
    }
  | {
      source: "moderation_detail";
      id: string;
      occurredAt: string;
      actorId: string | null;
      action: string;
      resourceType: "report";
      resourceId: string;
      scopeType: string;
      scopeId: string | null;
      detail: ModerationHistoryEntryDto;
    };

export interface AuditLogSearchResult {
  entries: AuditLogSearchEntry[];
}

/**
 * Translates the shared `AuditLogQueryFilters` into
 * `moderation.queryModerationHistory`'s own, differently-shaped filter
 * type — the two read paths are "kept intentionally symmetric" at the
 * caller's search-form level (Schema Sketch), not identical at the
 * implementation level, since `moderation`'s own aggregate has no
 * `actionPrefix`/`occurredAfter` concept of its own. `resourceId` maps to
 * `personId`/`reportId` only when `resourceType` says which one it is;
 * left unmapped otherwise (an audit-log-shaped `resourceId` for, say, a
 * `hour_entry` has no moderation-history equivalent to search for at all).
 */
function toModerationHistoryFilters(filters: AuditLogQueryFilters, limit: number) {
  return {
    personId: filters.resourceType === "person" ? filters.resourceId : undefined,
    reportId: filters.resourceType === "report" ? filters.resourceId : undefined,
    chapterId: filters.scopeId,
    cursor: filters.cursor,
    limit,
  };
}

function toPlatformAuditLogWhere(filters: AuditLogQueryFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.actorId) where.actorId = filters.actorId;
  if (filters.actionPrefix) where.action = { startsWith: filters.actionPrefix };
  if (filters.resourceType) where.resourceType = filters.resourceType;
  if (filters.resourceId) where.resourceId = filters.resourceId;
  if (filters.scopeId) where.scopeId = filters.scopeId;
  if (filters.occurredAfter || filters.occurredBefore) {
    where.occurredAt = {
      gte: filters.occurredAfter,
      lte: filters.occurredBefore,
    };
  }
  if (filters.cursor) where.id = { lt: filters.cursor };
  return where;
}

/**
 * `SearchAuditLog` (docs/ddd/admin-reporting.md, Key Use Case 6):
 * "dispatches to `admin.audit_log` and/or `moderation.queryModerationHistory(filters)`
 * per `source`, returning a normalized, unioned-in-application-code (never
 * in SQL) result set with a `source` tag per row."
 *
 * CRITICAL invariant: the two queries below run independently — one plain
 * Prisma query against this schema's own `admin.audit_log` table, one
 * call through `moderation`'s `index.ts` barrel into its own tables — and
 * are merged with a plain TypeScript array concat/sort AFTER both
 * `await`s resolve. There is no single SQL statement, view, or Prisma
 * query anywhere in this function that references both `admin.*` and
 * `moderation.*` tables — that is the hard architectural rule this Key
 * Use Case exists to enforce, not a style preference (see this module's
 * own `index.ts` header and docs/ddd/admin-reporting.md's Integration &
 * Anti-Corruption Notes, "`AuditLogQuery` is a function call, not a
 * join").
 */
export async function searchAuditLog(
  prisma: PrismaClient,
  input: { caller: PolicySubject; filters: AuditLogQueryFilters; source: AuditLogSearchSource },
): Promise<AuditLogSearchResult> {
  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "audit_log.search",
    { type: "audit_log", scopeType: "global", scopeId: null },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("audit_log.search");
  }

  const limit = Math.min(Math.max(input.filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const entries: AuditLogSearchEntry[] = [];

  if (input.source === "platform" || input.source === "both") {
    const rows = await prisma.auditLog.findMany({
      where: toPlatformAuditLogWhere(input.filters),
      orderBy: { id: "desc" },
      take: limit,
    });
    for (const row of rows) {
      entries.push({
        source: "platform_summary",
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        actorId: row.actorId,
        actorType: row.actorType,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        metadata: row.metadata,
      });
    }
  }

  if (input.source === "moderation_history" || input.source === "both") {
    // Through `moderation`'s own `index.ts` barrel — never a direct read
    // of `moderation.report`/`moderation.moderation_action`.
    const page = await queryModerationHistory(prisma, toModerationHistoryFilters(input.filters, limit));
    for (const detail of page.entries) {
      entries.push({
        source: "moderation_detail",
        id: detail.reportId,
        occurredAt: detail.createdAt,
        actorId: detail.resolutionAction?.moderatorPersonId ?? detail.reporterPersonId,
        action: detail.resolutionAction ? `moderation.${detail.resolutionAction.actionType}` : "moderation.report",
        resourceType: "report",
        resourceId: detail.reportId,
        scopeType: detail.scopeType,
        scopeId: detail.scopeId,
        detail,
      });
    }
  }

  // Application-code union (the invariant above) — a plain in-memory sort,
  // never a UNION/JOIN in SQL. Newest first, matching both source queries'
  // own individual ordering.
  entries.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));

  return { entries };
}
