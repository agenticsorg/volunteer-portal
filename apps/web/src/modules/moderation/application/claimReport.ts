import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { InvalidReportStatusTransitionError, OutOfScopeError, ReportNotFoundError } from "../domain/errors";
import { isLegalReportStatusTransition } from "../domain/reportStateMachine";

export interface ClaimReportInput {
  caller: PolicySubject;
  reportId: string;
}

export interface ClaimedReport {
  status: "reviewing";
}

/**
 * ClaimReport (docs/ddd/moderation-trust-safety.md, Key Use Case 2):
 * `open -> reviewing`, sets `assignedModeratorId`. Rejected with
 * `OutOfScopeError` if the caller's moderator `role_assignment` scope
 * doesn't cover the Report's own `scopeType`/`scopeId`
 * (`report.claim`, ADR-0007).
 */
export async function claimReport(prisma: PrismaClient, input: ClaimReportInput): Promise<ClaimedReport> {
  const report = await prisma.report.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ReportNotFoundError(input.reportId);
  }
  if (!isLegalReportStatusTransition(report.status, "reviewing")) {
    throw new InvalidReportStatusTransitionError(report.status, "reviewing");
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "report.claim",
    { type: "report", scopeType: report.scopeType === "org" ? "global" : "chapter", scopeId: report.scopeId },
    assignments,
  );
  if (!allowed) {
    throw new OutOfScopeError("report.claim");
  }

  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: input.reportId },
      data: { status: "reviewing", assignedModeratorId: input.caller.id },
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "report.claim",
      resourceType: "report",
      resourceId: input.reportId,
      scopeType: report.scopeType === "org" ? "global" : "chapter",
      scopeId: report.scopeId ?? undefined,
    });
  });

  return { status: "reviewing" };
}
