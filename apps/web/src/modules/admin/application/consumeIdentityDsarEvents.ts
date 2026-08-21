import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { recordProcessedEventAndHandle } from "./idempotentConsumption";

/** ADR-0011: `dsar_export`'s R2 lifecycle rule — "7 days for `dsar_export`". */
const DSAR_EXPORT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const RECOGNIZED_EVENT_TYPES = ["DsarExportCompleted", "DsarEraseCompleted"] as const;

/** A raw inbound event as read from `identity.domain_events` (mirrors `notifications`' own `InboundEvent`). */
export interface InboundIdentityEvent {
  /** The source event's own id (ULID) — the idempotency key (`admin.processed_events.id`). */
  sourceEventId: string;
  eventType: string;
  payload: unknown;
}

export interface ConsumeEventResult {
  processed: boolean;
  recognized: boolean;
}

/** The exact shape `identity`'s `submitDsarRequest.ts` publishes (see that file's own doc comment). */
interface DsarCompletionPayload {
  dsarId: string;
  personId: string;
  status: "completed" | "failed" | "pending" | "processing";
  resultUrl: string | null;
  completedAt: string | null;
  failureReason: string | null;
}

/**
 * `consumeIdentityDsarEvents` (docs/ddd/admin-reporting.md, Key Use Case 4:
 * "a small dedicated consumer ... drains `identity.domain_events` for
 * `DsarExportCompleted` / `DsarEraseCompleted`, and on receipt updates the
 * correlated `export_job`"). Structurally identical to every
 * `consume*Events` job `modules/notifications/application/` already
 * established (ADR-0009's generic external-event-consumer shape) — a raw
 * event is handed in (read by a caller from `identity.domain_events`, not
 * by this function itself, same separation notifications' own consumers
 * keep), dispatched by `eventType`, and idempotently applied.
 *
 * Reads NOTHING from `identity`'s tables — the entire correlation is
 * driven by `payload.dsarId` matching `ExportJob.identityDsarRequestId`
 * (this schema's own column) and the payload's own already-resolved
 * fields (`status`, `resultUrl`, `failureReason`). This is what keeps
 * `OrchestrateDsarRequest`'s "command, not a data pipe" guarantee true
 * end-to-end: neither it nor this consumer ever issues a query against
 * `identity.*`.
 */
export async function consumeIdentityDsarEvents(
  prisma: PrismaClient,
  event: InboundIdentityEvent,
): Promise<ConsumeEventResult> {
  if (!RECOGNIZED_EVENT_TYPES.includes(event.eventType as (typeof RECOGNIZED_EVENT_TYPES)[number])) {
    return { processed: false, recognized: false };
  }

  const payload = event.payload as DsarCompletionPayload;
  const isErase = event.eventType === "DsarEraseCompleted";
  const succeeded = payload.status === "completed";

  const result = await recordProcessedEventAndHandle(
    prisma,
    { id: event.sourceEventId, sourceContext: "identity", eventType: event.eventType },
    async (tx) => {
      const job = await tx.exportJob.findFirst({ where: { identityDsarRequestId: payload.dsarId } });
      if (!job) {
        // Not every `identity` DSAR request was orchestrated through
        // `admin` (a subject's own self-service export/erasure has no
        // correlated `ExportJob` at all) — nothing to update, and this is
        // not an error; the event is still marked processed via the
        // ledger insert above so it is never re-considered.
        return;
      }
      if (job.status === "completed" || job.status === "failed") {
        // `ExportJob` invariant 3 (terminal states are immutable) — a
        // redelivered/duplicate completion event for an already-resolved
        // job must be a strict no-op, not a second transition.
        return;
      }

      await tx.exportJob.update({
        where: { id: job.id },
        data: succeeded
          ? {
              status: "completed",
              completedAt: payload.completedAt ? new Date(payload.completedAt) : new Date(),
              // An erasure produces no downloadable artifact ("completion
              // is a status change, not an artifact" — Schema Sketch);
              // an export's `resultUrl` is `identity`'s own signed
              // delivery URL, stored as-is (see `submitDsarRequest.ts`'s
              // own doc comment on why this isn't a literal R2 key in
              // this phase).
              outputFileKey: isErase ? null : payload.resultUrl,
              outputFileFormat: isErase ? null : "zip",
              outputFileExpiresAt: isErase ? null : new Date(Date.now() + DSAR_EXPORT_EXPIRY_MS),
            }
          : {
              status: "failed",
              errorMessage: payload.failureReason ?? "The underlying identity DSAR request failed.",
            },
      });

      await tx.adminDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "ExportJob",
          aggregateId: job.id,
          eventType: succeeded ? "ExportJobCompleted" : "ExportJobFailed",
          payload: (succeeded
            ? {
                exportJobId: job.id,
                type: job.type,
                requestedByPersonId: job.requestedByPersonId,
                outputFileKey: isErase ? null : payload.resultUrl,
              }
            : {
                exportJobId: job.id,
                type: job.type,
                requestedByPersonId: job.requestedByPersonId,
                errorMessage: payload.failureReason ?? "The underlying identity DSAR request failed.",
              }) satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.adminDomainEvent, {
        actorId: job.requestedByPersonId,
        actorType: "system",
        action: succeeded ? "dsar.orchestration.completed" : "dsar.orchestration.failed",
        resourceType: "export_job",
        resourceId: job.id,
        metadata: { identityDsarRequestId: payload.dsarId, subjectId: payload.personId },
      });
    },
  );

  return { processed: result.processed, recognized: true };
}
