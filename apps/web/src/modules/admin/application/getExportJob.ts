import type { PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ExportJobNotFoundError, ForbiddenActionError } from "../domain/errors";
import type { ExportJobDto } from "./listExportJobs";

export interface GetExportJobInput {
  caller: PolicySubject;
  id: string;
}

/**
 * `exportJob.get` (API Contract Sketch) — single-row read, same
 * `export.request` `org_admin`-only gate as `listExportJobs` (see that
 * file's own doc comment on why this isn't `export.download`'s
 * self-or-org_admin ownership test: this is the admin console's own status
 * lookup, not the presigned-download-URL use case). The public,
 * unauthenticated-adjacent polling surface the API Contract Sketch also
 * describes (`GET /api/v1/admin/exports/:exportJobId`) is a separate REST
 * route, not this procedure.
 */
export async function getExportJob(prisma: PrismaClient, input: GetExportJobInput): Promise<ExportJobDto> {
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

  const row = await prisma.exportJob.findUnique({ where: { id: input.id } });
  if (!row) {
    throw new ExportJobNotFoundError(input.id);
  }

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
