import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments, submitDsarRequest, type DsarOperation } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

export interface OrchestrateDsarRequestInput {
  caller: PolicySubject;
  subjectId: string;
  operation: DsarOperation;
}

export interface OrchestratedDsarRequest {
  exportJobId: string;
  identityDsarRequestId: string;
}

/**
 * `OrchestrateDsarRequest` (docs/ddd/admin-reporting.md, Key Use Case 4) —
 * the admin-console surface to "trigger this on behalf of a person who
 * filed a request through a channel other than self-service" (Integration
 * & Anti-Corruption Notes).
 *
 * CRITICAL invariant, restated from that doc's own Notes: this function
 * calls `identity.submitDsarRequest(...)` — a COMMAND exported through
 * `identity`'s own `index.ts` barrel (ADR-0001) — and NEVER reads or
 * writes `identity.persons`/`identity.dsar_requests`/any other
 * `identity`-schema table directly. It does not even learn the outcome
 * synchronously: `submitDsarRequest` returns only the new
 * `identity.dsar_requests.id`, stored below as this row's own
 * `identityDsarRequestId` correlation key. The actual result (a signed
 * export URL, or erasure confirmation) is learned later, asynchronously,
 * by `consumeIdentityDsarEvents.ts` draining `identity.domain_events` for
 * `DsarExportCompleted`/`DsarEraseCompleted` — never by this function
 * reaching back into `identity`'s tables to check.
 */
export async function orchestrateDsarRequest(
  prisma: PrismaClient,
  input: OrchestrateDsarRequestInput,
): Promise<OrchestratedDsarRequest> {
  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "dsar.orchestrate",
    { type: "export_job", scopeType: "global", scopeId: null },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("dsar.orchestrate");
  }

  // The command call (ADR-0001) — `identity` owns everything about how
  // this actually gets fulfilled; this module supplies only who is asking
  // and on whose behalf.
  const { dsarId } = await submitDsarRequest(prisma, {
    subjectId: input.subjectId,
    operation: input.operation,
    requestedBy: { type: "admin", id: input.caller.id },
  });

  const exportJobId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.exportJob.create({
      data: {
        id: exportJobId,
        type: "dsar_export",
        status: "queued",
        requestedByPersonId: input.caller.id,
        params: { dsarOperation: input.operation, subjectId: input.subjectId } satisfies Prisma.InputJsonValue,
        identityDsarRequestId: dsarId,
      },
    });

    await tx.adminDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "ExportJob",
        aggregateId: exportJobId,
        eventType: "ExportJobQueued",
        payload: {
          exportJobId,
          type: "dsar_export",
          requestedByPersonId: input.caller.id,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.adminDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "dsar.orchestrated",
      resourceType: "export_job",
      resourceId: exportJobId,
      metadata: { subjectId: input.subjectId, operation: input.operation, identityDsarRequestId: dsarId },
    });
  });

  return { exportJobId, identityDsarRequestId: dsarId };
}
