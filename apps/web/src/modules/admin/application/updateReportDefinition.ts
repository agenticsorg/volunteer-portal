import { Prisma, type PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError, ReportDefinitionNotFoundError } from "../domain/errors";
import { assertValidFiltersForReportType } from "../domain/reportFilters";

export interface UpdateReportDefinitionInput {
  caller: PolicySubject;
  id: string;
  name?: string;
  description?: string | null;
  filters?: Record<string, unknown>;
  groupBy?: string[];
  hourlyValuationRateCents?: number;
  currency?: string;
  outputFormats?: string[];
  isActive?: boolean;
}

export interface UpdatedReportDefinition {
  id: string;
  updatedAt: string;
}

/**
 * `UpdateReportDefinition` (docs/ddd/admin-reporting.md, Key Use Case 2):
 * "mutates a definition in place (definitions are living config, unlike
 * jobs); does not retroactively affect any already-completed `ExportJob`."
 *
 * That last guarantee is NOT enforced by anything in this file — it holds
 * because `ExportJob.params.hourlyValuationRateCents` is a JSONB snapshot
 * `RequestExportJob` copies at request time and `ProcessExportJob` never
 * re-reads this row for an already-`queued`/`running`/terminal job (see
 * `requestExportJob.ts`'s and `processExportJob.ts`'s own doc comments —
 * the snapshotted-valuation-rate invariant this phase's whole `ExportJob`
 * design exists to protect). Editing `hourlyValuationRateCents` here is
 * exactly the mutation that invariant is defending against ever leaking
 * backward into a prior run's own stored figures — it correctly *does*
 * change what the *next* `RequestExportJob` call against this definition
 * will snapshot.
 */
export async function updateReportDefinition(
  prisma: PrismaClient,
  input: UpdateReportDefinitionInput,
): Promise<UpdatedReportDefinition> {
  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "report_definition.manage",
    { type: "report_definition", scopeType: "global", scopeId: null },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("report_definition.manage");
  }

  const existing = await prisma.reportDefinition.findUnique({ where: { id: input.id }, select: { reportType: true } });
  if (!existing) {
    throw new ReportDefinitionNotFoundError(input.id);
  }

  if (input.filters) {
    assertValidFiltersForReportType(existing.reportType, input.filters);
  }

  const updated = await prisma.reportDefinition.update({
    where: { id: input.id },
    data: {
      name: input.name,
      description: input.description,
      filters: input.filters as Prisma.InputJsonValue | undefined,
      groupBy: input.groupBy,
      hourlyValuationRateCents: input.hourlyValuationRateCents,
      currency: input.currency,
      outputFormats: input.outputFormats,
      isActive: input.isActive,
      updatedAt: new Date(),
    },
    select: { id: true, updatedAt: true },
  });

  return { id: updated.id, updatedAt: updated.updatedAt.toISOString() };
}
