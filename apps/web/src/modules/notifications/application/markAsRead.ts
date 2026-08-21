import type { PrismaClient } from "@prisma/client";
import { NotificationNotFoundError } from "../domain/errors";

export interface MarkAsReadInput {
  personId: string;
  notificationId: string;
}

export interface MarkedAsRead {
  notificationId: string;
  inAppReadAt: string;
}

/**
 * `MarkAsRead` (docs/ddd/notifications.md, Key Use Case 4) — sets
 * `in_app_read_at = now()` on a `notification` row owned by `personId`.
 * Idempotent: marking an already-read notification as read is a no-op,
 * not an error — the existing `inAppReadAt` is returned unchanged rather
 * than overwritten with a new timestamp. Ownership is enforced by the
 * `WHERE recipient_person_id = personId` on both the lookup and the
 * update — a notification that exists but belongs to someone else raises
 * the same `NotificationNotFoundError` as one that doesn't exist at all,
 * so this never leaks whether a given id belongs to another person.
 */
export async function markAsRead(prisma: PrismaClient, input: MarkAsReadInput): Promise<MarkedAsRead> {
  const existing = await prisma.notification.findFirst({
    where: { id: input.notificationId, recipientPersonId: input.personId },
    select: { id: true, inAppReadAt: true },
  });
  if (!existing) {
    throw new NotificationNotFoundError(input.notificationId);
  }

  if (existing.inAppReadAt) {
    return { notificationId: existing.id, inAppReadAt: existing.inAppReadAt.toISOString() };
  }

  const readAt = new Date();
  const updated = await prisma.notification.updateMany({
    where: { id: existing.id, inAppReadAt: null },
    data: { inAppReadAt: readAt },
  });

  if (updated.count === 0) {
    // Lost a race with a concurrent MarkAsRead — still idempotent, just
    // report the timestamp the other call actually won with.
    const current = await prisma.notification.findUniqueOrThrow({
      where: { id: existing.id },
      select: { inAppReadAt: true },
    });
    return { notificationId: existing.id, inAppReadAt: current.inAppReadAt!.toISOString() };
  }

  return { notificationId: existing.id, inAppReadAt: readAt.toISOString() };
}
