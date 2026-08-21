import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { InvalidReportStatusTransitionError, NotClaimHolderError, ReportNotFoundError } from "../domain/errors";

export interface ReleaseReportClaimInput {
  caller: PolicySubject;
  reportId: string;
}

export interface ReleasedReportClaim {
  status: "open";
}

/**
 * ReleaseReportClaim (docs/ddd/moderation-trust-safety.md, Key Use Case
 * 3): `reviewing -> open`, clears `assignedModeratorId`. Only the assigned
 * moderator (or an `org_admin`) may release a claim (`report.release_claim`,
 * ADR-0007) — e.g. "going on leave."
 */
export async function releaseReportClaim(
  prisma: PrismaClient,
  input: ReleaseReportClaimInput,
): Promise<ReleasedReportClaim> {
  const report = await prisma.report.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ReportNotFoundError(input.reportId);
  }
  if (report.status !== "reviewing") {
    throw new InvalidReportStatusTransitionError(report.status, "open");
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "report.release_claim",
    { type: "report", scopeType: "global", scopeId: null, ownerId: report.assignedModeratorId ?? undefined },
    assignments,
  );
  if (!allowed) {
    throw new NotClaimHolderError("report.release_claim");
  }

  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: input.reportId },
      data: { status: "open", assignedModeratorId: null },
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "report.release_claim",
      resourceType: "report",
      resourceId: input.reportId,
    });
  });

  return { status: "open" };
}
