import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import {
  ForbiddenActionError,
  ReportDefinitionNotActiveError,
  ReportDefinitionNotFoundError,
} from "../domain/errors";
import { resolveApprovedHoursDateWindow, type ApprovedHoursSummaryFilters } from "../domain/reportFilters";
import { processExportJob } from "./processExportJob";

export interface RequestExportJobInput {
  caller: PolicySubject;
  type: "grant_report" | "custom";
  /** Required for `type: 'grant_report'`; ignored for `'custom'`. */
  reportDefinitionId?: string;
  /**
   * Optional per-run overrides for `'grant_report'` — a narrower date
   * window than the definition's own stored `filters` resolve to, e.g. a
   * one-off re-run for a specific quarter. Anything not overridden here
   * resolves from the `ReportDefinition` itself.
   */
  dateOverride?: { fromDate: string; toDate: string };
  /** Must be one of the definition's own `outputFormats`; defaults to the first. */
  outputFormat?: "csv" | "pdf";
  /** `type: 'custom'` only — an opaque, caller-defined params bag this phase does not interpret further. */
  customParams?: Record<string, unknown>;
}

export interface RequestedExportJob {
  exportJobId: string;
  status: "queued" | "completed" | "failed";
}

/** The exact shape `processExportJob.ts` reads back out of `ExportJob.params` for a `'grant_report'` run. */
export interface GrantReportExportParams {
  reportType: string;
  chapterIds?: string[];
  opportunityIds?: string[];
  fromDate: string;
  toDate: string;
  /**
   * Copied from `ReportDefinition.hourlyValuationRateCents` AT REQUEST TIME
   * — this is the whole point of this field existing on `ExportJob.params`
   * rather than being read live from the definition. See this function's
   * own "Snapshotted valuation rate" doc section below.
   */
  hourlyValuationRateCents: number;
  currency: string;
  outputFormat: "csv" | "pdf";
}

/**
 * `RequestExportJob` (docs/ddd/admin-reporting.md, Key Use Case 3):
 * "validates authorization ..., resolves and snapshots concrete `params`
 * (including the valuation rate, if `reportDefinitionId` is set), inserts
 * an `export_job` row with `status = 'queued'`, writes `ExportJobQueued`,
 * and enqueues the `processExportJob` graphile-worker job."
 *
 * `type: 'dsar_export'` is deliberately NOT accepted here — the API
 * Contract Sketch gives DSAR its own `orchestrateDsar` procedure
 * (`OrchestrateDsarRequest`, `orchestrateDsarRequest.ts`), which this
 * function does not delegate to internally: the two use cases take
 * genuinely different inputs (`{ subjectId, operation }` vs. `{ type,
 * reportDefinitionId, ... }`), so a caller asking for a DSAR export should
 * call that procedure directly rather than this one silently branching.
 *
 * ## Snapshotted valuation rate (invariant 1)
 * `hourlyValuationRateCents` is read from `ReportDefinition` exactly once,
 * right here, and copied into `ExportJob.params` — never re-read from
 * `ReportDefinition` again by anything downstream (`processExportJob.ts`
 * only ever reads `job.params.hourlyValuationRateCents`, never
 * `reportDefinition.hourlyValuationRateCents`). This is what makes
 * `UpdateReportDefinition` editing a definition's rate provably unable to
 * change a previously-completed report's own dollar figures: by the time
 * that edit happens, this function has already run and its snapshot is
 * sitting immutably in a different row's `params` column.
 *
 * No async job runner is wired up for this bounded context yet (same
 * "nothing else exists to fan out to this phase" substitution
 * `modules/identity/application/requestDataExport.ts`'s own header
 * documents for its own synchronous `processExport` call) — `queued`'s
 * row commits first, then `processExportJob` runs synchronously,
 * in-process, right after. `processExportJob` itself never throws (it
 * catches its own failures and records them on the job row — see its own
 * doc comment), so this function's returned `status` reliably reflects the
 * outcome without needing its own try/catch.
 */
export async function requestExportJob(
  prisma: PrismaClient,
  input: RequestExportJobInput,
): Promise<RequestedExportJob> {
  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "export.request",
    { type: "export_job", scopeType: "global", scopeId: null },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("export.request");
  }

  const exportJobId = newId();
  let params: Prisma.InputJsonValue;

  if (input.type === "grant_report") {
    if (!input.reportDefinitionId) {
      throw new ReportDefinitionNotFoundError("(none provided)");
    }
    const definition = await prisma.reportDefinition.findUnique({ where: { id: input.reportDefinitionId } });
    if (!definition) {
      throw new ReportDefinitionNotFoundError(input.reportDefinitionId);
    }
    if (!definition.isActive) {
      throw new ReportDefinitionNotActiveError(input.reportDefinitionId);
    }

    const filters = definition.filters as unknown as ApprovedHoursSummaryFilters;
    const { fromDate, toDate } = input.dateOverride ?? resolveApprovedHoursDateWindow(filters, new Date());
    const outputFormat = (input.outputFormat ?? (definition.outputFormats[0] as "csv" | "pdf" | undefined) ?? "csv") as
      | "csv"
      | "pdf";
    if (!definition.outputFormats.includes(outputFormat)) {
      throw new Error(
        `outputFormat "${outputFormat}" is not in report definition "${definition.id}"'s outputFormats (${definition.outputFormats.join(", ")}).`,
      );
    }

    const grantParams: GrantReportExportParams = {
      reportType: definition.reportType,
      chapterIds: filters.chapterIds,
      opportunityIds: filters.opportunityIds,
      fromDate,
      toDate,
      // Snapshotted here, once — the load-bearing line for invariant 1.
      hourlyValuationRateCents: definition.hourlyValuationRateCents,
      currency: definition.currency,
      outputFormat,
    };
    params = grantParams as unknown as Prisma.InputJsonValue;
  } else {
    params = (input.customParams ?? {}) as Prisma.InputJsonValue;
  }

  await prisma.$transaction(async (tx) => {
    await tx.exportJob.create({
      data: {
        id: exportJobId,
        type: input.type,
        status: "queued",
        reportDefinitionId: input.type === "grant_report" ? input.reportDefinitionId : undefined,
        requestedByPersonId: input.caller.id,
        params,
      },
    });

    await tx.adminDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "ExportJob",
        aggregateId: exportJobId,
        eventType: "ExportJobQueued",
        payload: {
          exportJobId,
          type: input.type,
          requestedByPersonId: input.caller.id,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.adminDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "export.requested",
      resourceType: "export_job",
      resourceId: exportJobId,
      metadata: { type: input.type, reportDefinitionId: input.reportDefinitionId ?? null },
    });
  });

  const result = await processExportJob(prisma, exportJobId);
  return { exportJobId, status: result.status };
}
