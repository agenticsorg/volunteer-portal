import type { PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

export interface ListReportDefinitionsInput {
  caller: PolicySubject;
  /** Defaults to `true` — a disabled definition may still be referenced by historical `ExportJob` rows, but the admin console's own list defaults to what can actually be run again. */
  activeOnly?: boolean;
}

export interface ReportDefinitionDto {
  id: string;
  name: string;
  description: string | null;
  reportType: string;
  filters: unknown;
  groupBy: string[];
  hourlyValuationRateCents: number;
  currency: string;
  outputFormats: string[];
  isActive: boolean;
  createdByPersonId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `reportDefinition.list` (API Contract Sketch) — the read half of Key Use
 * Cases 1/2's own `ReportDefinition` aggregate, `org_admin`-only same as
 * `CreateReportDefinition`/`UpdateReportDefinition` (`report_definition.manage`
 * — this module has no separate "view" authz action, and the sketch's own
 * `orgAdminProcedure` gates this procedure identically to `create`/`update`).
 */
export async function listReportDefinitions(
  prisma: PrismaClient,
  input: ListReportDefinitionsInput,
): Promise<ReportDefinitionDto[]> {
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

  const rows = await prisma.reportDefinition.findMany({
    where: input.activeOnly === false ? undefined : { isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    reportType: row.reportType,
    filters: row.filters,
    groupBy: row.groupBy,
    hourlyValuationRateCents: row.hourlyValuationRateCents,
    currency: row.currency,
    outputFormats: row.outputFormats,
    isActive: row.isActive,
    createdByPersonId: row.createdByPersonId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
