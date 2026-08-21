import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";

/**
 * Writes one row to this context's own transactional outbox
 * (`notifications.domain_events`, ADR-0009) — always called from *inside*
 * the same `prisma.$transaction` as the state change it announces, same
 * shape as every other module's own `publish*Event` helper (e.g.
 * `gamification`'s `publishGamificationEvent.ts`). docs/ddd/notifications.md's
 * "Published" event table: `NotificationQueued` (a `Notification` row is
 * created), `NotificationDelivered` (a `DeliveryAttempt` transitions to
 * `sent`), `NotificationFailed` (a `DeliveryAttempt` exhausts retries or
 * bounces). No other bounded context currently subscribes to these — this
 * context is overwhelmingly a consumer, not a producer — but they're
 * written all the same, for the same admin-observability/traceability
 * reason every other outbox row exists.
 */
export interface NotificationsEventInput {
  eventType: "NotificationQueued" | "NotificationDelivered" | "NotificationFailed";
  /** Always `notification.id` — the `Notification` is this context's one aggregate root. */
  aggregateId: string;
  payload: Prisma.InputJsonValue;
}

export async function publishNotificationsEvent(
  tx: Prisma.TransactionClient,
  event: NotificationsEventInput,
): Promise<void> {
  await tx.notificationsDomainEvent.create({
    data: {
      id: newId(),
      aggregateType: "Notification",
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
    },
  });
}
