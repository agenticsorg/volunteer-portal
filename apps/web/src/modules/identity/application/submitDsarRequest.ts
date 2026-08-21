import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { requestDataExport } from "./requestDataExport";
import { requestErasure } from "./requestErasure";

export type DsarOperation = "export" | "erase";

/**
 * `identity.submitDsarRequest(...)` (docs/ddd/admin-reporting.md, Key Use
 * Case 4 / Integration & Anti-Corruption Notes' "DSAR orchestration is a
 * command, not a data pipe") — the one command `admin`'s
 * `OrchestrateDsarRequest` is allowed to call, exported through this
 * module's own `index.ts` per ADR-0001. `requestedBy.type` is carried
 * through only for the caller's own bookkeeping/audit narrative (identity's
 * own `RequestDataExport`/`RequestErasure` use cases, which this function
 * delegates to unchanged, only ever record `requestedBy.id` — the same
 * `identity.persons.id` a self-service caller would pass); the DSAR
 * machinery itself does not branch on who initiated the request.
 */
export interface SubmitDsarRequestInput {
  subjectId: string;
  operation: DsarOperation;
  requestedBy: { type: "admin" | "self"; id: string };
}

export interface SubmittedDsarRequest {
  dsarId: string;
}

/** `identity.dsar_requests.type`, matching `requestDataExport.ts`/`requestErasure.ts`'s own literal values. */
function dsarRequestTypeFor(operation: DsarOperation): "export" | "erasure" {
  return operation === "export" ? "export" : "erasure";
}

/** The event type this operation's completion is published under (docs/ddd/admin-reporting.md Key Use Case 4). */
function completionEventTypeFor(operation: DsarOperation): "DsarExportCompleted" | "DsarEraseCompleted" {
  return operation === "export" ? "DsarExportCompleted" : "DsarEraseCompleted";
}

export async function submitDsarRequest(
  prisma: PrismaClient,
  input: SubmitDsarRequestInput,
): Promise<SubmittedDsarRequest> {
  const dsarType = dsarRequestTypeFor(input.operation);
  const eventType = completionEventTypeFor(input.operation);

  let dsarId: string;
  try {
    if (input.operation === "export") {
      dsarId = (await requestDataExport(prisma, { personId: input.subjectId, requestedBy: input.requestedBy.id })).dsarId;
    } else {
      dsarId = (await requestErasure(prisma, { personId: input.subjectId, requestedBy: input.requestedBy.id })).dsarId;
    }
  } catch (error) {
    // `requestDataExport`'s `processExport` step marks the `DSARRequest`
    // row `failed` and *re-throws* (see that file's own `processExport`
    // doc comment) — this phase's DSAR machinery runs synchronously
    // in-process rather than as an async graphile-worker job, so a
    // generation-time failure surfaces as a thrown error here rather than
    // a later job-failure callback. Recover the row that call already
    // created (there is one, since the throw happened after the row's
    // insert, inside `processExport`) so a completion event can still
    // fire — this is the only way `admin`'s `ExportJob` ever learns the
    // run failed, since `OrchestrateDsarRequest` never reads
    // `identity.dsar_requests` directly. `requestErasure` has no
    // equivalent recoverable-failure path (its whole state transition is
    // one Prisma `$transaction` — it either fully commits to `completed`
    // or fully rolls back with *no* row created at all), so this recovery
    // branch is only ever reachable for `operation === "export"`; for
    // `erase`, and for any pre-transaction validation failure on either
    // path (`ForbiddenActionError`, `PersonNotFoundError`, ...), no row
    // exists to recover and the error is simply re-thrown — the request
    // was never actually submitted, so there is nothing for `admin` to
    // correlate against.
    const recovered = await prisma.dSARRequest.findFirst({
      where: {
        personId: input.subjectId,
        type: dsarType,
        requestedBy: input.requestedBy.id,
        status: "failed",
      },
      orderBy: { requestedAt: "desc" },
    });
    if (!recovered) {
      throw error;
    }
    dsarId = recovered.id;
  }

  await publishDsarCompletionEvent(prisma, dsarId, eventType);

  return { dsarId };
}

/**
 * Publishes `DsarExportCompleted`/`DsarEraseCompleted` to
 * `identity.domain_events` — the event `admin`'s `consumeIdentityDsarEvents`
 * drains to correlate the outcome back to the originating `ExportJob`. Not
 * tagged `audit: true`: the underlying `RequestDataExport`/`RequestErasure`
 * use cases this function delegates to already record their own
 * `recordAuditEvent()` audit trail for the privileged action itself (the
 * export/erasure request); this event is purely the cross-context
 * completion signal, not a second audit entry for the same action.
 *
 * `resultUrl` mirrors `identity.dsar_requests.result_url`'s intent (ADR-0014
 * §2) as this codebase's actual `DSARRequest.exportFileUrl` — a
 * locally-signed, expiring app URL (`requestDataExport.ts`'s own header:
 * "no object-storage credentials exist ... a real file is written to local
 * disk and served back through a real signed, expiring URL"), not a raw R2
 * object key. `admin`'s consumer stores this value as-is in
 * `ExportJob.outputFileKey` — the field name inherited from
 * `docs/ddd/admin-reporting.md`'s Schema Sketch, populated here with
 * whatever `identity`'s own DSAR export delivery mechanism actually
 * produces, matching every other documented "no real cloud storage this
 * phase" substitution already established across this codebase (R2
 * upload/download itself stays behind this module's own adapter boundary
 * regardless — see `modules/admin/infra/cloudflareR2Client.ts`).
 */
async function publishDsarCompletionEvent(
  prisma: PrismaClient,
  dsarId: string,
  eventType: "DsarExportCompleted" | "DsarEraseCompleted",
): Promise<void> {
  const request = await prisma.dSARRequest.findUniqueOrThrow({ where: { id: dsarId } });

  await prisma.identityDomainEvent.create({
    data: {
      id: newId(),
      aggregateType: "DSARRequest",
      aggregateId: dsarId,
      eventType,
      payload: {
        dsarId: request.id,
        personId: request.personId,
        status: request.status,
        resultUrl: request.exportFileUrl,
        completedAt: request.completedAt ? request.completedAt.toISOString() : null,
        failureReason: request.failureReason,
      } satisfies Prisma.InputJsonValue,
    },
  });
}
