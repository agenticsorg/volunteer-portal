import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { InvalidReportStatusTransitionError, NotClaimHolderError, ReportNotFoundError } from "../domain/errors";
import { publishModerationEvent } from "./publishModerationEvent";

export interface ResolveReportInput {
  caller: PolicySubject;
  reportId: string;
  resolutionActionId?: string;
  resolutionNotes?: string;
}

export interface ResolvedReport {
  status: "resolved";
}

/**
 * ResolveReport (docs/ddd/moderation-trust-safety.md, Key Use Case 5):
 * `reviewing -> resolved`, optionally recording `resolutionActionId` (a
 * `TakeModerationAction` result) and `resolutionNotes`, emits
 * `ReportResolved`. Report invariant 4: only the `assignedModeratorId`
 * currently holding the claim, or an `org_admin` (`report.resolve`,
 * ADR-0007).
 */
export async function resolveReport(prisma: PrismaClient, input: ResolveReportInput): Promise<ResolvedReport> {
  const report = await prisma.report.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ReportNotFoundError(input.reportId);
  }
  if (report.status !== "reviewing") {
    throw new InvalidReportStatusTransitionError(report.status, "resolved");
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "report.resolve",
    { type: "report", scopeType: "global", scopeId: null, ownerId: report.assignedModeratorId ?? undefined },
    assignments,
  );
  if (!allowed) {
    throw new NotClaimHolderError("report.resolve");
  }

  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: input.reportId },
      data: {
        status: "resolved",
        resolutionActionId: input.resolutionActionId ?? null,
        resolutionNotes: input.resolutionNotes ?? null,
        resolvedAt: new Date(),
      },
    });

    await publishModerationEvent(tx, {
      eventType: "ReportResolved",
      aggregateType: "Report",
      aggregateId: input.reportId,
      payload: { reportId: input.reportId, resolutionActionId: input.resolutionActionId ?? null },
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "report.resolve",
      resourceType: "report",
      resourceId: input.reportId,
      metadata: { resolutionActionId: input.resolutionActionId ?? null },
    });
  });

  return { status: "resolved" };
}
