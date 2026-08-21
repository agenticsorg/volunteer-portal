import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { sweepExpiredDsarExportBundles, sweepInactivePersons } from "@/modules/identity";
import { sweepModerationLogs } from "@/modules/moderation";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface DataClassSweepOutcome {
  affectedCount: number;
}

/**
 * One entry per `admin.retention_policies.data_class` this phase can
 * actually act on — each calling straight through the owning module's own
 * `index.ts` barrel, per ADR-0014 §3 ("for each data class invokes a
 * schema-owned sweep function ... keeping the 'how do I query/mutate my
 * own tables' logic inside the owning schema") and this phase's own
 * explicit "invoke each owning schema's own cleanup function directly"
 * requirement. Deliberately a plain object literal, not a generic
 * "build a cross-schema query from the data_class string" mechanism —
 * the one thing this dispatch table must never become.
 */
const DATA_CLASS_HANDLERS: Record<
  string,
  { targetSchema: string; sweep: (prisma: PrismaClient, cutoff: Date) => Promise<DataClassSweepOutcome> }
> = {
  inactive_volunteer_pii: {
    targetSchema: "identity",
    sweep: async (prisma, cutoff) => ({ affectedCount: (await sweepInactivePersons(prisma, cutoff)).anonymizedCount }),
  },
  moderation_logs: {
    targetSchema: "moderation",
    sweep: async (prisma, cutoff) => {
      const result = await sweepModerationLogs(prisma, cutoff);
      return { affectedCount: result.reportsAnonymized + result.actionsAnonymized };
    },
  },
  dsar_export_bundles: {
    targetSchema: "identity",
    sweep: async (prisma, cutoff) => ({
      affectedCount: (await sweepExpiredDsarExportBundles(prisma, cutoff)).deletedCount,
    }),
  },
  // `video_watch_events` and `session_tokens` (ADR-0014 §3's other two
  // seeded data classes) have no handler here: this codebase does not
  // model a raw per-event video-watch log distinct from `training`'s own
  // `ModuleProgress` (the aggregate completion state that data class's own
  // policy text says must be *retained* for certificates — there is
  // nothing safe to delete without an actual event-log table), and
  // `session_tokens` has no owning table in this Prisma schema at all
  // (Supabase Auth owns session/login state externally). Both are handled
  // by the fallback branch in `runRetentionSweep` below — skipped with a
  // clear reason, never silently dropped and never faked with an
  // invented table.
};

export interface RetentionSweepDataClassResult {
  dataClass: string;
  action: string;
  cutoff: string;
  affectedCount: number;
  skipped: boolean;
  skipReason?: string;
}

export interface RetentionSweepResult {
  results: RetentionSweepDataClassResult[];
}

/**
 * `retention_sweep` (ADR-0014 §3; docs/ddd/admin-reporting.md's
 * `RetentionPolicyExpired` event) — reads `admin.retention_policies`
 * where `enabled = true` and, for each data class, computes
 * `cutoff = now - retentionDays` and invokes that data class's own
 * owning-schema cleanup function (see `DATA_CLASS_HANDLERS` above),
 * exactly the "identify rows past their retention window per data class
 * and invoke each owning schema's own cleanup function directly" shape
 * this phase's brief specifies — never a generic cross-schema `DELETE`.
 *
 * This is the application-layer sweep LOGIC; `apps/worker/src/tasks/
 * retention-sweep.ts` is the graphile-worker task that calls this on a
 * recurring schedule, same split `audit-log-writer.ts` already keeps
 * between its own scheduling/self-rescheduling concerns and (in that
 * task's case, inlined) sweep logic.
 *
 * Every data class swept (whether it found 0 or N stale rows) gets its
 * own `RetentionPolicyExpired` event and its own `sweep_executed` audit
 * entry (ADR-0014 §3: "Sweep runs are themselves audit-logged ...
 * with row counts affected") — one row per data class, not one summary
 * row for the whole run, so an auditor can see exactly which data classes
 * were evaluated and what each one did on any given run.
 */
export async function runRetentionSweep(prisma: PrismaClient, now: Date = new Date()): Promise<RetentionSweepResult> {
  const policies = await prisma.retentionPolicy.findMany({ where: { enabled: true } });
  const results: RetentionSweepDataClassResult[] = [];

  for (const policy of policies) {
    const cutoff = new Date(now.getTime() - policy.retentionDays * MS_PER_DAY);
    const handler = DATA_CLASS_HANDLERS[policy.dataClass];

    if (!handler) {
      results.push({
        dataClass: policy.dataClass,
        action: policy.action,
        cutoff: cutoff.toISOString(),
        affectedCount: 0,
        skipped: true,
        skipReason: "No owning-schema cleanup function is registered for this data class this phase.",
      });
      continue;
    }

    const { affectedCount } = await handler.sweep(prisma, cutoff);

    await prisma.$transaction(async (tx) => {
      await tx.adminDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "RetentionSweep",
          aggregateId: `${policy.dataClass}:${now.toISOString()}`,
          eventType: "RetentionPolicyExpired",
          payload: {
            dataClass: policy.dataClass,
            cutoff: cutoff.toISOString(),
            targetSchema: handler.targetSchema,
            action: policy.action,
            affectedCount,
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.adminDomainEvent, {
        actorId: null,
        actorType: "system",
        action: "sweep_executed",
        resourceType: "retention_policy",
        resourceId: policy.id,
        metadata: { dataClass: policy.dataClass, cutoff: cutoff.toISOString(), affectedCount },
      });
    });

    results.push({
      dataClass: policy.dataClass,
      action: policy.action,
      cutoff: cutoff.toISOString(),
      affectedCount,
      skipped: false,
    });
  }

  return { results };
}
