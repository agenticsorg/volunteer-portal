import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";

/** Marks an already-anonymized actor reference — also this sweep's own idempotency signal (see below). */
const ANON_PREFIX = "anon_";

function isAnonymized(personId: string | null): boolean {
  return personId !== null && personId.startsWith(ANON_PREFIX);
}

function anonToken(): string {
  return `${ANON_PREFIX}${newId()}`;
}

export interface SweepModerationLogsResult {
  reportsAnonymized: number;
  actionsAnonymized: number;
}

/**
 * `moderation.sweepModerationLogs(cutoff)` — the owning-schema cleanup
 * function `admin`'s `retention_sweep` job (ADR-0014 §3) invokes directly
 * for the `moderation_logs` data class ("1095 days (3 years) -> anonymize
 * actor references, retain action/reason"). Exported through this
 * module's own `index.ts` (ADR-0001) — `admin` calls this function, it
 * never issues its own `UPDATE` against `moderation.report`/
 * `moderation.moderation_action`.
 *
 * Anonymizes only the ACTOR references the ADR's own wording scopes this
 * to — `Report.reporterPersonId`/`assignedModeratorId` and
 * `ModerationAction.moderatorPersonId`/`revokedByPersonId` — using the
 * same `anon_<ulid>` stable-token shape ADR-0014 §2 already establishes
 * for `identity`'s own erasure job. `ModerationAction.targetPersonId` is
 * deliberately left untouched: it is the subject of the sanction, not an
 * "actor" in the ADR's sense, and moderation-history lookups against a
 * target (e.g. "does this person have an active suspension") must keep
 * working regardless of how old the underlying action is — the ADR's own
 * "retain action/reason" half of this data class's rule.
 *
 * Idempotent by construction: an actor field already carrying the
 * `anon_` prefix is excluded from the sweep's own `WHERE`, so re-running
 * this against the same cutoff (this job runs hourly, per ADR-0014 §3,
 * against a growing cutoff window) never re-anonymizes an already-swept
 * row. Each row gets its own fresh anonymization token (not a single
 * token shared across every row a given actor touched) — a deliberate,
 * documented simplification for a scheduled bulk sweep (as opposed to
 * `identity.requestErasure`'s single-subject, single-request token),
 * since correlating "these N old rows were the same actor" has no
 * retention-policy purpose once the actor identity itself is no longer
 * being retained.
 */
export async function sweepModerationLogs(prisma: PrismaClient, cutoff: Date): Promise<SweepModerationLogsResult> {
  const staleReports = await prisma.report.findMany({
    where: { createdAt: { lt: cutoff }, reporterPersonId: { not: { startsWith: ANON_PREFIX } } },
    select: { id: true, assignedModeratorId: true },
  });
  for (const report of staleReports) {
    await prisma.report.update({
      where: { id: report.id },
      data: {
        reporterPersonId: anonToken(),
        assignedModeratorId:
          report.assignedModeratorId === null
            ? null
            : isAnonymized(report.assignedModeratorId)
              ? report.assignedModeratorId
              : anonToken(),
      },
    });
  }

  const staleActions = await prisma.moderationAction.findMany({
    where: { createdAt: { lt: cutoff }, moderatorPersonId: { not: { startsWith: ANON_PREFIX } } },
    select: { id: true, revokedByPersonId: true },
  });
  for (const action of staleActions) {
    await prisma.moderationAction.update({
      where: { id: action.id },
      data: {
        moderatorPersonId: anonToken(),
        revokedByPersonId: action.revokedByPersonId ? anonToken() : null,
      },
    });
  }

  return { reportsAnonymized: staleReports.length, actionsAnonymized: staleActions.length };
}
