import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import { PersonNotFoundError, SelfReportNotAllowedError } from "../domain/errors";
import type { ReportedEntityType, ReportReason } from "../domain/reportedEntityTypes";
import { resolveReportedEntitySnapshot } from "./resolveReportedEntitySnapshot";
import { publishModerationEvent } from "./publishModerationEvent";

export interface EvidenceAttachmentInput {
  r2ObjectKey: string;
  contentType: string;
  sizeBytes: number;
}

export interface FileReportInput {
  caller: PolicySubject;
  reportedEntityType: ReportedEntityType;
  reportedEntityId: string;
  reason: ReportReason;
  reasonDetail?: string;
  evidenceAttachments?: EvidenceAttachmentInput[];
}

export interface FiledReport {
  reportId: string;
}

const MAX_EVIDENCE_ATTACHMENTS = 6;

/**
 * FileReport (docs/ddd/moderation-trust-safety.md, Key Use Case 1).
 * Validates Report invariant 1 (anti-self-report), captures
 * `reportedContentSnapshot` and `scopeType`/`scopeId` ONCE via
 * `resolveReportedEntitySnapshot` (never re-synced afterward — the
 * evidentiary guarantee this aggregate exists for), persists the Report as
 * `open`, and emits `ReportFiled`.
 *
 * No `can()` gate: filing a report is a plain authenticated-volunteer
 * action available to every `Person` in good standing, not a privileged
 * moderator action — same "not every mutation is `can()`-gated" shape
 * `community`'s own API Contract Sketch already establishes for its own
 * plain `protectedProcedure`s.
 */
export async function fileReport(prisma: PrismaClient, input: FileReportInput): Promise<FiledReport> {
  if (input.reportedEntityType === "identity.person" && input.caller.id === input.reportedEntityId) {
    throw new SelfReportNotAllowedError();
  }

  const evidenceAttachments = input.evidenceAttachments ?? [];
  if (evidenceAttachments.length > MAX_EVIDENCE_ATTACHMENTS) {
    throw new RangeError(`A report may carry at most ${MAX_EVIDENCE_ATTACHMENTS} evidence attachments.`);
  }

  const reporter = await getPersonSummary(prisma, input.caller.id);
  if (!reporter) {
    throw new PersonNotFoundError(input.caller.id);
  }

  const { snapshot, scopeType, scopeId } = await resolveReportedEntitySnapshot(
    prisma,
    input.reportedEntityType,
    input.reportedEntityId,
  );

  const reportId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.report.create({
      data: {
        id: reportId,
        reporterPersonId: input.caller.id,
        reportedEntityType: input.reportedEntityType,
        reportedEntityId: input.reportedEntityId,
        reportedContentSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        reason: input.reason,
        reasonDetail: input.reasonDetail ?? null,
        evidenceAttachments: evidenceAttachments as unknown as Prisma.InputJsonValue,
        scopeType,
        scopeId,
      },
    });

    await publishModerationEvent(tx, {
      eventType: "ReportFiled",
      aggregateType: "Report",
      aggregateId: reportId,
      payload: {
        reportId,
        reporterPersonId: input.caller.id,
        reportedEntityType: input.reportedEntityType,
        reportedEntityId: input.reportedEntityId,
        reason: input.reason,
      },
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "report.file",
      resourceType: "report",
      resourceId: reportId,
      scopeType: scopeType === "org" ? "global" : "chapter",
      scopeId: scopeId ?? undefined,
      metadata: {
        reportedEntityType: input.reportedEntityType,
        reportedEntityId: input.reportedEntityId,
        reason: input.reason,
        evidenceAttachmentCount: evidenceAttachments.length,
      },
    });
  });

  return { reportId };
}
