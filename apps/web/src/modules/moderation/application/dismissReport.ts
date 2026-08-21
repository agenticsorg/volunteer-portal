import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import {
  InvalidReportStatusTransitionError,
  NotClaimHolderError,
  OutOfScopeError,
  ReportNotFoundError,
} from "../domain/errors";
import { publishModerationEvent } from "./publishModerationEvent";

export interface DismissReportInput {
  caller: PolicySubject;
  reportId: string;
  resolutionNotes: string;
}

export interface DismissedReport {
  status: "dismissed";
}

/**
 * DismissReport (docs/ddd/moderation-trust-safety.md, Key Use Case 6):
 * `open -> dismissed` (fast-dismiss, no prior claim) or
 * `reviewing -> dismissed`, with mandatory `resolutionNotes`, emits
 * `ReportDismissed`.
 *
 * Authority is state-dependent, per Report invariant 4 and the state
 * machine's own "fast-dismiss" branch:
 * - from `open`: no `assignedModeratorId` exists yet to check ownership
 *   against, so this is the same moderator scope-authority test as
 *   `ClaimReport` (`report.claim`).
 * - from `reviewing`: only the claim holder, or an `org_admin`
 *   (`report.resolve` — the same ownership shape `ResolveReport` uses,
 *   since invariant 4 states this once for both `resolved` and
 *   `dismissed`).
 */
export async function dismissReport(prisma: PrismaClient, input: DismissReportInput): Promise<DismissedReport> {
  const report = await prisma.report.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ReportNotFoundError(input.reportId);
  }
  if (report.status !== "open" && report.status !== "reviewing") {
    throw new InvalidReportStatusTransitionError(report.status, "dismissed");
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);

  if (report.status === "open") {
    const allowed = can(
      input.caller,
      "report.claim",
      { type: "report", scopeType: report.scopeType === "org" ? "global" : "chapter", scopeId: report.scopeId },
      assignments,
    );
    if (!allowed) {
      throw new OutOfScopeError("report.claim");
    }
  } else {
    const allowed = can(
      input.caller,
      "report.resolve",
      { type: "report", scopeType: "global", scopeId: null, ownerId: report.assignedModeratorId ?? undefined },
      assignments,
    );
    if (!allowed) {
      throw new NotClaimHolderError("report.resolve");
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: input.reportId },
      data: { status: "dismissed", resolutionNotes: input.resolutionNotes, resolvedAt: new Date() },
    });

    await publishModerationEvent(tx, {
      eventType: "ReportDismissed",
      aggregateType: "Report",
      aggregateId: input.reportId,
      payload: { reportId: input.reportId, resolutionNotes: input.resolutionNotes },
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "report.dismiss",
      resourceType: "report",
      resourceId: input.reportId,
    });
  });

  return { status: "dismissed" };
}
