import { Prisma, type PrismaClient } from "@prisma/client";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface QueryModerationHistoryFilters {
  /**
   * Matches a Report whose `reporterPersonId` is this person, whose
   * `reportedEntityType = 'identity.person'` and `reportedEntityId` is
   * this person, OR whose resolving `ModerationAction.targetPersonId` is
   * this person — "the complete moderation history on this person" spans
   * all three roles a Person plays in this context's data.
   */
  personId?: string;
  /** Matches `Report.scopeId` where `scopeType = 'chapter'`. */
  chapterId?: string;
  reportId?: string;
  /** Last-seen `report.id`, for keyset pagination (ULID order — ADR-0005). */
  cursor?: string;
  limit?: number;
}

export interface ModerationHistoryResolutionActionDto {
  actionId: string;
  actionType: "warn" | "mute" | "suspend" | "ban";
  targetPersonId: string;
  moderatorPersonId: string;
  reason: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  startsAt: string;
  endsAt: string | null;
  status: "active" | "expired" | "revoked";
}

/**
 * One denormalized entry `admin.queryModerationHistory`'s caller (a much
 * later Admin & Reporting phase) receives — a Report joined, in-process,
 * with its resolving `ModerationAction` if one exists (docs/ddd/
 * moderation-trust-safety.md, Integration & Anti-Corruption Notes:
 * "returning denormalized DTOs that join a Report with its resolving
 * ModerationAction(s) in-process (never a SQL join across schemas)" —
 * `Report`/`ModerationAction` share this schema, so this actually is a
 * same-schema Prisma `include`, not a cross-schema join; the "never a SQL
 * join across schemas" guarantee this doc calls out is about this
 * function's own callers never reaching past it into `moderation`'s
 * tables directly, not about this function's own internal query shape).
 * Deliberately excludes `reportedContentSnapshot`/`evidenceAttachments`
 * from this summary shape's own doc comment framing — callers needing the
 * full picture read the returned `reportId` against a more detailed
 * lookup; this function's job is the queryable list, not the full record.
 */
export interface ModerationHistoryEntryDto {
  reportId: string;
  reportedEntityType: string;
  reportedEntityId: string;
  reporterPersonId: string;
  reason: string;
  reasonDetail: string | null;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  scopeType: "org" | "chapter";
  scopeId: string | null;
  assignedModeratorId: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionAction: ModerationHistoryResolutionActionDto | null;
}

export interface ModerationHistoryPage {
  entries: ModerationHistoryEntryDto[];
  nextCursor: string | null;
}

/**
 * `moderation.queryModerationHistory(filters)` (docs/ddd/
 * moderation-trust-safety.md, Integration & Anti-Corruption Notes) — the
 * Open Host Service query a later Admin & Reporting phase depends on
 * existing, built now per this phase's own build item 6, "even though
 * nothing calls it yet" (same precedent `volunteering.queryApprovedHours`
 * set in Phase 3). Deliberately carries no `can()` gate itself — same
 * "this function only ever answers what the filtered data says, not
 * whether this caller is allowed to ask" shape `queryApprovedHours`'s own
 * doc comment establishes; that authorization belongs at the calling
 * procedure/router layer a later stage builds.
 */
export async function queryModerationHistory(
  prisma: PrismaClient,
  filters: QueryModerationHistoryFilters,
): Promise<ModerationHistoryPage> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const conditions: Prisma.ReportWhereInput[] = [];
  if (filters.reportId) conditions.push({ id: filters.reportId });
  if (filters.chapterId) conditions.push({ scopeType: "chapter", scopeId: filters.chapterId });
  if (filters.personId) {
    conditions.push({
      OR: [
        { reporterPersonId: filters.personId },
        { reportedEntityType: "identity.person", reportedEntityId: filters.personId },
        { resolutionAction: { targetPersonId: filters.personId } },
      ],
    });
  }
  if (filters.cursor) conditions.push({ id: { lt: filters.cursor } });

  const rows = await prisma.report.findMany({
    where: conditions.length > 0 ? { AND: conditions } : undefined,
    include: { resolutionAction: true },
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  const entries = page.map((row) => ({
    reportId: row.id,
    reportedEntityType: row.reportedEntityType,
    reportedEntityId: row.reportedEntityId,
    reporterPersonId: row.reporterPersonId,
    reason: row.reason,
    reasonDetail: row.reasonDetail,
    status: row.status,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    assignedModeratorId: row.assignedModeratorId,
    resolutionNotes: row.resolutionNotes,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolutionAction: row.resolutionAction
      ? {
          actionId: row.resolutionAction.id,
          actionType: row.resolutionAction.actionType,
          targetPersonId: row.resolutionAction.targetPersonId,
          moderatorPersonId: row.resolutionAction.moderatorPersonId,
          reason: row.resolutionAction.reason,
          scopeType: row.resolutionAction.scopeType,
          scopeId: row.resolutionAction.scopeId,
          startsAt: row.resolutionAction.startsAt.toISOString(),
          endsAt: row.resolutionAction.endsAt ? row.resolutionAction.endsAt.toISOString() : null,
          status: row.resolutionAction.status,
        }
      : null,
  }));

  return { entries, nextCursor };
}
