import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import type { NotificationChannel, NotificationType } from "@volunteer-portal/shared";
import type { SourceContext } from "../domain/inboundEvents";
import { getEffectivePreference } from "./getEffectivePreference";
import { publishNotificationsEvent } from "./publishNotificationsEvent";

export interface QueueNotificationCommand {
  recipientPersonId: string;
  type: NotificationType;
  /** The channel(s) the caller is requesting — the QUEUE-TIME gate below narrows this down to the *effective* set. */
  requestedChannels: readonly NotificationChannel[];
  /** Everything the eventual template needs to render — a snapshot, never re-read later (Notification invariant 3). */
  payload: Prisma.InputJsonValue;
  sourceContext: SourceContext;
  sourceEventId: string;
}

export interface QueueNotificationResult {
  /** `true` iff every requested channel was opted out — no `Notification` row was created (a normal, silent outcome, not a failure). */
  suppressed: boolean;
  notificationId: string | null;
}

function effectiveChannelUnion(channels: readonly NotificationChannel[]): "email" | "in_app" | "both" {
  const hasEmail = channels.includes("email");
  const hasInApp = channels.includes("in_app");
  if (hasEmail && hasInApp) return "both";
  return hasEmail ? "email" : "in_app";
}

/**
 * `QueueNotification` (docs/ddd/notifications.md, Key Use Case 1) —
 * internal only, never called directly by an API client, only by event
 * handlers (`application/handlers/**`) and (a later stage's) reminder
 * scheduler.
 *
 * **This is the QUEUE-TIME half of Notification invariant 1** — the first
 * of the two independent consent gates: computes the effective channel set
 * = `requestedChannels` ∩ each channel's *currently* enabled preference
 * (`getEffectivePreference`, read fresh, right now, inside this same
 * transaction — never a value computed or cached anywhere earlier). If the
 * resulting set is empty, this is a no-op: **no `Notification` row is
 * created at all** — a suppressed notification, not a failed one, because
 * failure implies an attempt was made and an opted-out person should see
 * zero evidence a notification was even considered. Otherwise inserts
 * `notification` + one `delivery_attempt` per effective channel (`in_app`
 * immediately `sent`, `email` `pending`) + the `NotificationQueued` (and,
 * for `in_app`, `NotificationDelivered`) outbox rows, all together.
 *
 * Idempotent on `(sourceEventId, recipientPersonId)` two ways: the caller
 * (an event handler) already reserved `sourceEventId` in
 * `notifications.processed_events` before calling this
 * (`idempotentConsumption.ts`), and `notification`'s own
 * `notification_source_event_recipient_uq` unique index is a second,
 * independent line of defense against a duplicate row specifically.
 *
 * Must be called from *inside* the caller's own `prisma.$transaction` —
 * same transaction as that `processed_events` ledger insert, so a
 * suppressed outcome still commits atomically with "this source event has
 * been handled" (no row to create, but the event is still fully processed,
 * not left pending for retry).
 */
export async function queueNotification(
  tx: Prisma.TransactionClient,
  command: QueueNotificationCommand,
): Promise<QueueNotificationResult> {
  const effectiveChannels: NotificationChannel[] = [];
  for (const channel of command.requestedChannels) {
    const enabled = await getEffectivePreference(tx, command.recipientPersonId, command.type, channel);
    if (enabled) effectiveChannels.push(channel);
  }

  if (effectiveChannels.length === 0) {
    return { suppressed: true, notificationId: null };
  }

  const notificationId = newId();
  const createdAt = new Date();
  const channel = effectiveChannelUnion(effectiveChannels);

  await tx.notification.create({
    data: {
      id: notificationId,
      recipientPersonId: command.recipientPersonId,
      type: command.type,
      payload: command.payload,
      channel,
      sourceContext: command.sourceContext,
      sourceEventId: command.sourceEventId,
      createdAt,
    },
  });

  await publishNotificationsEvent(tx, {
    eventType: "NotificationQueued",
    aggregateId: notificationId,
    payload: { notificationId, recipientPersonId: command.recipientPersonId, type: command.type, channel },
  });

  if (effectiveChannels.includes("in_app")) {
    // DeliveryAttempt invariant: in_app has no real "provider" — writing
    // the Notification row *is* the delivery, so this attempt is created
    // already `sent`, `attemptedAt = createdAt`, in the same transaction.
    const deliveryAttemptId = newId();
    await tx.deliveryAttempt.create({
      data: { id: deliveryAttemptId, notificationId, channel: "in_app", status: "sent", attemptedAt: createdAt },
    });
    await publishNotificationsEvent(tx, {
      eventType: "NotificationDelivered",
      aggregateId: notificationId,
      payload: { notificationId, deliveryAttemptId, channel: "in_app", providerMessageId: null },
    });
  }

  if (effectiveChannels.includes("email")) {
    // Starts `pending` — `ProcessDeliveryJob` (a later worker invocation)
    // picks this up and re-checks the DELIVERY-TIME gate independently.
    const deliveryAttemptId = newId();
    await tx.deliveryAttempt.create({
      data: { id: deliveryAttemptId, notificationId, channel: "email", status: "pending" },
    });
  }

  return { suppressed: false, notificationId };
}
