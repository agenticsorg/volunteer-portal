import type { PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError, ReportDefinitionNotFoundError } from "../domain/errors";
import type { ReportDefinitionDto } from "./listReportDefinitions";

export interface GetReportDefinitionInput {
  caller: PolicySubject;
  id: string;
}

/**
 * `reportDefinition.get` (API Contract Sketch) — single-row read, same
 * `report_definition.manage` `org_admin`-only gate as `listReportDefinitions`/
 * `CreateReportDefinition`/`UpdateReportDefinition`.
 */
export async function getReportDefinition(
  prisma: PrismaClient,
  input: GetReportDefinitionInput,
): Promise<ReportDefinitionDto> {
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

  const row = await prisma.reportDefinition.findUnique({ where: { id: input.id } });
  if (!row) {
    throw new ReportDefinitionNotFoundError(input.id);
  }

  return {
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
  };
}
