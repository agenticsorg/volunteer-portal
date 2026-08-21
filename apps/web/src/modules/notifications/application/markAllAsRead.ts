import type { PrismaClient } from "@prisma/client";

export interface MarkAllAsReadInput {
  personId: string;
}

export interface MarkedAllAsRead {
  markedCount: number;
}

/**
 * `MarkAllAsRead` (docs/ddd/notifications.md, Key Use Case 5) — bulk
 * variant of `MarkAsRead` for every unread `in_app`-channel notification
 * belonging to `personId`. "In_app-channel" means `channel IN ('in_app',
 * 'both')` — `Notification.channel`'s own doc comment: `in_app_read_at` is
 * "only meaningful when `channel` includes `in_app`," which `'both'` does.
 */
export async function markAllAsRead(prisma: PrismaClient, input: MarkAllAsReadInput): Promise<MarkedAllAsRead> {
  const result = await prisma.notification.updateMany({
    where: {
      recipientPersonId: input.personId,
      channel: { in: ["in_app", "both"] },
      inAppReadAt: null,
    },
    data: { inAppReadAt: new Date() },
  });

  return { markedCount: result.count };
}
