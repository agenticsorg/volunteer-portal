import { Prisma, type PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListExportJobsFilters {
  requestedByPersonId?: string;
  type?: string;
  status?: string;
  /** Last-seen `export_job.id`, for keyset pagination (ULID order — ADR-0005). */
  cursor?: string;
  limit?: number;
}

export interface ListExportJobsInput extends ListExportJobsFilters {
  caller: PolicySubject;
}

export interface ExportJobDto {
  id: string;
  type: string;
  status: string;
  reportDefinitionId: string | null;
  requestedByPersonId: string;
  params: unknown;
  identityDsarRequestId: string | null;
  outputFileKey: string | null;
  outputFileFormat: string | null;
  outputFileExpiresAt: string | null;
  rowCount: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ExportJobPage {
  entries: ExportJobDto[];
  nextCursor: string | null;
}

function toDto(row: {
  id: string;
  type: string;
  status: string;
  reportDefinitionId: string | null;
  requestedByPersonId: string;
  params: unknown;
  identityDsarRequestId: string | null;
  outputFileKey: string | null;
  outputFileFormat: string | null;
  outputFileExpiresAt: Date | null;
  rowCount: number | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): ExportJobDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    reportDefinitionId: row.reportDefinitionId,
    requestedByPersonId: row.requestedByPersonId,
    params: row.params,
    identityDsarRequestId: row.identityDsarRequestId,
    outputFileKey: row.outputFileKey,
    outputFileFormat: row.outputFileFormat,
    outputFileExpiresAt: row.outputFileExpiresAt ? row.outputFileExpiresAt.toISOString() : null,
    rowCount: row.rowCount,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `exportJob.list` (API Contract Sketch) — the read half of `ExportJob`'s
 * lifecycle (Key Use Cases 3/4/5), `org_admin`-only same as
 * `RequestExportJob`/`OrchestrateDsarRequest` (`export.request` — this
 * module has no separate "view" authz action, and every `exportJob.*`
 * procedure in the sketch is `orgAdminProcedure`; unlike
 * `GetExportDownloadUrl`'s own `export.download` action, this list is not
 * "self-or-org_admin" scoped — it is the admin console's own cross-caller
 * job list).
 */
export async function listExportJobs(prisma: PrismaClient, input: ListExportJobsInput): Promise<ExportJobPage> {
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

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const conditions: Prisma.ExportJobWhereInput[] = [];
  if (input.requestedByPersonId) conditions.push({ requestedByPersonId: input.requestedByPersonId });
  if (input.type) conditions.push({ type: input.type });
  if (input.status) conditions.push({ status: input.status });
  if (input.cursor) conditions.push({ id: { lt: input.cursor } });

  const rows = await prisma.exportJob.findMany({
    where: conditions.length > 0 ? { AND: conditions } : undefined,
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { entries: page.map(toDto), nextCursor };
}
