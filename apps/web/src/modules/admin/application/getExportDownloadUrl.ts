import type { PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import {
  ExportJobDownloadExpiredError,
  ExportJobNotDownloadableError,
  ExportJobNotFoundError,
  ForbiddenActionError,
} from "../domain/errors";
import { cloudflareR2Adapter } from "../infra/cloudflareR2Client";

export interface GetExportDownloadUrlInput {
  caller: PolicySubject;
  exportJobId: string;
}

export interface ExportDownloadUrl {
  url: string;
  expiresAt: string;
}

/**
 * `GetExportDownloadUrl` (docs/ddd/admin-reporting.md, Key Use Case 7):
 * "authorizes (`can(subject, 'export:download', exportJob)` — generally:
 * the original requester or any `org_admin`), checks `status = 'completed'`
 * and `outputFileExpiresAt > now()` (else `410 Gone`), mints a presigned R2
 * GET URL (15-minute TTL, per ADR-0011), never returns a raw bucket URL."
 */
export async function getExportDownloadUrl(
  prisma: PrismaClient,
  input: GetExportDownloadUrlInput,
): Promise<ExportDownloadUrl> {
  const job = await prisma.exportJob.findUnique({ where: { id: input.exportJobId } });
  if (!job) {
    throw new ExportJobNotFoundError(input.exportJobId);
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "export.download",
    { type: "export_job", scopeType: "global", scopeId: null, ownerId: job.requestedByPersonId },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("export.download");
  }

  if (job.status !== "completed" || !job.outputFileKey) {
    throw new ExportJobNotDownloadableError(input.exportJobId);
  }
  if (!job.outputFileExpiresAt || job.outputFileExpiresAt <= new Date()) {
    throw new ExportJobDownloadExpiredError(input.exportJobId);
  }

  const signed = await cloudflareR2Adapter.createDownloadUrl(job.outputFileKey);
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
