import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";
import { assertValidFiltersForReportType } from "../domain/reportFilters";

const DEFAULT_HOURLY_VALUATION_RATE_CENTS = 3614; // Independent Sector 2026 rate (Schema Sketch default).
const DEFAULT_CURRENCY = "USD";
const DEFAULT_OUTPUT_FORMATS: readonly string[] = ["csv", "pdf"];

export interface CreateReportDefinitionInput {
  caller: PolicySubject;
  name: string;
  description?: string;
  reportType: string;
  filters: Record<string, unknown>;
  groupBy?: string[];
  hourlyValuationRateCents?: number;
  currency?: string;
  outputFormats?: string[];
}

export interface CreatedReportDefinition {
  id: string;
  createdAt: string;
}

/**
 * `CreateReportDefinition` (docs/ddd/admin-reporting.md, Key Use Case 1):
 * "validates `filters`/`groupBy` against the known shape for `reportType`,
 * defaults `hourlyValuationRateCents` to `3614` if omitted, persists."
 * `org_admin`-only (`report_definition.manage`, API Contract Sketch's
 * `orgAdminProcedure`).
 */
export async function createReportDefinition(
  prisma: PrismaClient,
  input: CreateReportDefinitionInput,
): Promise<CreatedReportDefinition> {
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

  assertValidFiltersForReportType(input.reportType, input.filters);

  const id = newId();
  const created = await prisma.reportDefinition.create({
    data: {
      id,
      name: input.name,
      description: input.description,
      reportType: input.reportType,
      filters: input.filters as Prisma.InputJsonValue,
      groupBy: input.groupBy ?? [],
      hourlyValuationRateCents: input.hourlyValuationRateCents ?? DEFAULT_HOURLY_VALUATION_RATE_CENTS,
      currency: input.currency ?? DEFAULT_CURRENCY,
      outputFormats: input.outputFormats ?? [...DEFAULT_OUTPUT_FORMATS],
      createdByPersonId: input.caller.id,
    },
    select: { id: true, createdAt: true },
  });

  return { id: created.id, createdAt: created.createdAt.toISOString() };
}
