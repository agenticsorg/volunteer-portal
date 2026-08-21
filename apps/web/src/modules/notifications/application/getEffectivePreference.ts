import type { Prisma, PrismaClient } from "@prisma/client";
import { getNotificationTypeDefault, type NotificationChannel, type NotificationType } from "@volunteer-portal/shared";

/**
 * The structural read this needs — satisfied by both a plain `PrismaClient`
 * and a `prisma.$transaction`'s `tx` — so the SAME function serves both
 * gates docs/ddd/notifications.md's Notification invariant 1 requires:
 * `QueueNotification`'s queue-time gate (called with a `tx`, inside the
 * event handler's own transaction) and `ProcessDeliveryJob`'s
 * delivery-time gate (called with the plain `prisma` client, as its own
 * fresh, independent read — see that function's own doc comment for why
 * this distinction matters).
 */
type PreferenceReadClient = {
  notificationPreference: {
    findUnique(args: {
      where: { personId_type_channel: { personId: string; type: string; channel: string } };
    }): Promise<{ enabled: boolean } | null>;
  };
};

/**
 * `GetEffectivePreference` — resolves whether `personId` currently wants
 * `type` notifications delivered over `channel`: their explicit
 * `NotificationPreference` row if one exists (`enabled`), else the
 * type/channel's documented platform default
 * (`@volunteer-portal/shared`'s `notificationDefaults.ts`).
 *
 * This is deliberately the ONLY place either gate reads preference state,
 * so both gates are provably checking the identical rule — not two
 * independently-drifting implementations of "is this opted out."
 */
export async function getEffectivePreference(
  client: PrismaClient | Prisma.TransactionClient | PreferenceReadClient,
  personId: string,
  type: NotificationType,
  channel: NotificationChannel,
): Promise<boolean> {
  const row = await (client as PreferenceReadClient).notificationPreference.findUnique({
    where: { personId_type_channel: { personId, type, channel } },
  });
  if (row) return row.enabled;
  return getNotificationTypeDefault(type, channel);
}
