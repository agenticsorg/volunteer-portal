import type { PrismaClient } from "@prisma/client";
import { getPersonContactInfo } from "@/modules/identity";
import type { NotificationType } from "@volunteer-portal/shared";
import { DeliveryAttemptNotEmailChannelError, DeliveryAttemptNotFoundError } from "../domain/errors";
import { getEffectivePreference } from "./getEffectivePreference";
import { publishNotificationsEvent } from "./publishNotificationsEvent";
import { renderNotificationEmail } from "./renderNotificationEmail";
import { resendAdapter, type ResendAdapter } from "../infra/resendClient";

export type ProcessDeliveryJobOutcome = "sent" | "suppressed_preference_revoked" | "failed" | "already_terminal";

export interface ProcessDeliveryJobResult {
  outcome: ProcessDeliveryJobOutcome;
  errorMessage?: string;
}

/**
 * `ProcessDeliveryJob` (docs/ddd/notifications.md, Key Use Case 3) — the
 * graphile-worker job (a later infra stage's own polling/scheduling; this
 * function is the fully-real, directly-callable unit of work it invokes)
 * that performs actual delivery for `pending` (or previously `failed`,
 * mid-retry) `email` `delivery_attempt` rows.
 *
 * **This is the DELIVERY-TIME half of Notification invariant 1** — the
 * second of the two independent consent gates, and it is genuinely
 * independent: this function does not receive, trust, or reuse any
 * decision `QueueNotification` made — it re-reads `notification_preference`
 * for `(recipientPersonId, notification.type, 'email')` FRESH, right now,
 * via the exact same `getEffectivePreference` helper `QueueNotification`
 * itself uses (so both gates are provably the same rule, checked at two
 * different times, never one cached result). If now disabled — a
 * preference revoked in the window between queueing and this call — the
 * attempt is marked `failed` with `errorMessage = 'preference_revoked'`
 * and Resend is never contacted.
 *
 * Otherwise renders the template for `notification.type`
 * (`renderNotificationEmail`, from `notification.payload` alone — no live
 * cross-context lookup), resolves the recipient's email via
 * `identity.getPersonContactInfo`, and calls the Resend adapter. On
 * success: `providerMessageId` recorded, `status = 'sent'`,
 * `attemptedAt = now()`, `NotificationDelivered` published. On any error
 * (Resend rejects the call, the adapter throws
 * `ExternalServiceNotConfiguredError` because this environment has no
 * `RESEND_API_KEY`, the recipient has no resolvable contact info):
 * `retryCount` incremented, `status = 'failed'`, `errorMessage` recorded,
 * `NotificationFailed` published — graphile-worker's own retry/backoff
 * (a later stage) decides whether/when to invoke this function again.
 *
 * Idempotent against redelivery: a `delivery_attempt` already in a
 * terminal state (`sent`/`bounced`) is a no-op — `failed` is NOT terminal
 * here (it's the state graphile-worker retries from), matching
 * docs/ddd/notifications.md's own "eligible for retry ... via
 * graphile-worker's native retry" framing.
 */
export async function processDeliveryJob(
  prisma: PrismaClient,
  deliveryAttemptId: string,
  adapter: ResendAdapter = resendAdapter,
): Promise<ProcessDeliveryJobResult> {
  const attempt = await prisma.deliveryAttempt.findUnique({
    where: { id: deliveryAttemptId },
    include: { notification: true },
  });
  if (!attempt) {
    throw new DeliveryAttemptNotFoundError(deliveryAttemptId);
  }
  if (attempt.channel !== "email") {
    throw new DeliveryAttemptNotEmailChannelError(deliveryAttemptId, attempt.channel);
  }
  if (attempt.status === "sent" || attempt.status === "bounced") {
    return { outcome: "already_terminal" };
  }

  const notificationType = attempt.notification.type as NotificationType;
  const recipientPersonId = attempt.notification.recipientPersonId;

  // DELIVERY-TIME gate — see this function's own doc comment above.
  const stillEnabled = await getEffectivePreference(prisma, recipientPersonId, notificationType, "email");
  if (!stillEnabled) {
    await prisma.$transaction(async (tx) => {
      await tx.deliveryAttempt.update({
        where: { id: attempt.id },
        data: { status: "failed", errorMessage: "preference_revoked", attemptedAt: new Date() },
      });
      await publishNotificationsEvent(tx, {
        eventType: "NotificationFailed",
        aggregateId: attempt.notificationId,
        payload: {
          notificationId: attempt.notificationId,
          deliveryAttemptId: attempt.id,
          channel: "email",
          status: "failed",
          errorMessage: "preference_revoked",
        },
      });
    });
    return { outcome: "suppressed_preference_revoked", errorMessage: "preference_revoked" };
  }

  const recordFailure = async (errorMessage: string): Promise<ProcessDeliveryJobResult> => {
    await prisma.$transaction(async (tx) => {
      await tx.deliveryAttempt.update({
        where: { id: attempt.id },
        data: { status: "failed", attemptedAt: new Date(), retryCount: { increment: 1 }, errorMessage },
      });
      await publishNotificationsEvent(tx, {
        eventType: "NotificationFailed",
        aggregateId: attempt.notificationId,
        payload: { notificationId: attempt.notificationId, deliveryAttemptId: attempt.id, channel: "email", status: "failed", errorMessage },
      });
    });
    return { outcome: "failed", errorMessage };
  };

  const contact = await getPersonContactInfo(prisma, recipientPersonId);
  if (!contact) {
    return recordFailure(`No deliverable contact email for person "${recipientPersonId}".`);
  }

  const email = renderNotificationEmail(notificationType, attempt.notification.payload);

  let sendResult: { providerMessageId: string };
  try {
    sendResult = await adapter.sendTransactionalEmail({
      to: contact.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  } catch (error) {
    return recordFailure(error instanceof Error ? error.message : String(error));
  }

  await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "sent", providerMessageId: sendResult.providerMessageId, attemptedAt: new Date() },
    });
    await publishNotificationsEvent(tx, {
      eventType: "NotificationDelivered",
      aggregateId: attempt.notificationId,
      payload: {
        notificationId: attempt.notificationId,
        deliveryAttemptId: attempt.id,
        channel: "email",
        providerMessageId: sendResult.providerMessageId,
      },
    });
  });

  return { outcome: "sent" };
}
