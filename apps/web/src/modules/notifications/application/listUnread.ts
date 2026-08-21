import type { PrismaClient } from "@prisma/client";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface ListUnreadInput {
  personId: string;
  /** Last-seen `notification.id`, for keyset pagination (ULID order — ADR-0005). */
  cursor?: string;
  limit?: number;
}

export interface NotificationListItemDTO {
  notificationId: string;
  type: string;
  payload: unknown;
  channel: string;
  sourceContext: string;
  createdAt: string;
}

export interface UnreadNotificationPage {
  entries: NotificationListItemDTO[];
  nextCursor: string | null;
}

/**
 * `ListUnread` (docs/ddd/notifications.md, Key Use Case 6) —
 * cursor-paginated list of `notification` rows for `personId` where
 * `channel` includes `in_app` and `in_app_read_at IS NULL`, newest first.
 * Backed directly by `notification_unread_idx`
 * (`(recipient_person_id, created_at DESC) WHERE in_app_read_at IS NULL`)
 * — this is, per that index's own migration comment, "the hottest read
 * path in this schema." Keyset pagination on `id` (ULID, so `id` order and
 * `createdAt` order agree) matches the same `id: { lt: cursor }` /
 * `orderBy: { id: 'desc' }` shape `community`'s own feed pagination uses.
 */
export async function listUnread(prisma: PrismaClient, input: ListUnreadInput): Promise<UnreadNotificationPage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.notification.findMany({
    where: {
      recipientPersonId: input.personId,
      channel: { in: ["in_app", "both"] },
      inAppReadAt: null,
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  const entries = page.map((row) => ({
    notificationId: row.id,
    type: row.type,
    payload: row.payload,
    channel: row.channel,
    sourceContext: row.sourceContext,
    createdAt: row.createdAt.toISOString(),
  }));

  return { entries, nextCursor };
}
