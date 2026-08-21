import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { attachRequestMetadata, getRequestId } from "@volunteer-portal/observability";

/**
 * Writes one row to this context's own transactional outbox
 * (`moderation.domain_events`, ADR-0009) — always called from *inside* the
 * same `prisma.$transaction` as the state change it announces, same "write
 * the event in the same transaction as the write it describes" shape as
 * every other module's own `publish*Event` helper (e.g. `community`'s
 * `publishCommunityEvent.ts`). Downstream, `community` (hide/restrict
 * content, lift a restriction) and `notifications` (inform the affected
 * user/reporter) drain this table — a future infra-layer worker task's
 * job, not this stage's.
 *
 * Deliberately distinct from `@volunteer-portal/audit`'s
 * `recordAuditEvent()` — that helper writes its own separate
 * `event_type = 'audit.recorded'` row (tagged `audit: true`) for every
 * privileged mutation in this context; this helper writes the *named*
 * business event (`ReportFiled`, `ModerationActionTaken`, ...) a real
 * subscriber acts on. Every use case that has both calls both, same "two
 * separate outbox rows per privileged write" precedent
 * `community`'s `createPost.ts`/`giveKudos.ts` already established.
 */
export interface ModerationEventInput {
  eventType: "ReportFiled" | "ReportResolved" | "ReportDismissed" | "ModerationActionTaken" | "ModerationActionRevoked";
  aggregateType: "Report" | "ModerationAction";
  aggregateId: string;
  payload: Prisma.InputJsonValue;
}

export async function publishModerationEvent(
  tx: Prisma.TransactionClient,
  event: ModerationEventInput,
): Promise<void> {
  await tx.moderationDomainEvent.create({
    data: {
      id: newId(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      // ADR-0013 §"Correlation": stamps the current request's requestId
      // onto payload._meta.requestId — see publishCommunityEvent.ts's
      // matching doc comment for the full rationale.
      payload: attachRequestMetadata(event.payload, getRequestId()),
    },
  });
}
