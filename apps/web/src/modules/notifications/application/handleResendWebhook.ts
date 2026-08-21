import type { PrismaClient } from "@prisma/client";
import { publishNotificationsEvent } from "./publishNotificationsEvent";

/** The two Resend webhook event types this handler reacts to (ADR-0012's "bounce/complaint" note). */
export type ResendWebhookEventType = "email.bounced" | "email.complained";

export interface ResendWebhookEvent {
  type: ResendWebhookEventType;
  /** Resend's `data.email_id` — correlates back to `delivery_attempt.provider_message_id`. */
  providerMessageId: string;
}

export interface HandleResendWebhookResult {
  /** `false` when `providerMessageId` doesn't match any known `delivery_attempt` — logged, not errored, per this use case's own contract below. */
  matched: boolean;
  /** `false` when the matched attempt wasn't `sent` (e.g. already `bounced`) — a no-op, not an error. */
  transitioned: boolean;
}

/**
 * `HandleResendWebhook` (docs/ddd/notifications.md, Key Use Case 7) —
 * internal, called by the REST webhook receiver
 * (`apps/web/app/api/webhooks/resend/route.ts`, a later stage; that route
 * verifies `ResendAdapter.verifyWebhookSignature` before ever calling this
 * function with the parsed body). Looks up the `delivery_attempt` by
 * `providerMessageId` and transitions `sent -> bounced` on a
 * `bounce`/`complaint` event.
 *
 * "Ignored (logged, not errored) if the `providerMessageId` is unknown
 * (e.g. a delivery attempt from a different environment)" — the doc's own
 * words, verbatim: an unmatched id is a normal, expected occurrence (a
 * webhook replay, a differently-seeded dev/staging Resend account sharing
 * one webhook endpoint), not a defect in this handler, so it returns a
 * result the caller can log rather than throwing.
 */
export async function handleResendWebhook(
  prisma: PrismaClient,
  event: ResendWebhookEvent,
): Promise<HandleResendWebhookResult> {
  // `findFirst`, not `findUnique`: `delivery_attempt_provider_message_uq` is
  // a PARTIAL unique index (`WHERE provider_message_id IS NOT NULL`,
  // migration.sql) — Prisma's schema language has no partial-index syntax
  // (schema.prisma's own header comment on this table), so this column
  // isn't declared `@unique` at the Prisma-client level even though the DB
  // itself enforces uniqueness among non-null values.
  const attempt = await prisma.deliveryAttempt.findFirst({
    where: { providerMessageId: event.providerMessageId },
  });
  if (!attempt) {
    return { matched: false, transitioned: false };
  }

  // `bounced` is a terminal state reachable only from `sent` (DeliveryAttempt
  // invariant), never re-triggered by a redelivered/duplicate webhook.
  if (attempt.status !== "sent") {
    return { matched: true, transitioned: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempt.update({
      where: { id: attempt.id, status: "sent" },
      data: { status: "bounced", errorMessage: event.type },
    });
    await publishNotificationsEvent(tx, {
      eventType: "NotificationFailed",
      aggregateId: attempt.notificationId,
      payload: { notificationId: attempt.notificationId, deliveryAttemptId: attempt.id, channel: "email", status: "bounced", errorMessage: event.type },
    });
  });

  return { matched: true, transitioned: true };
}
