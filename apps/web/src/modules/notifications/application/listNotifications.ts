import type { PrismaClient } from "@prisma/client";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface ListNotificationsInput {
  personId: string;
  /** Last-seen `notification.id`, for keyset pagination (ULID order — ADR-0005). */
  cursor?: string;
  limit?: number;
}

export interface NotificationHistoryItemDTO {
  notificationId: string;
  type: string;
  payload: unknown;
  channel: string;
  sourceContext: string;
  inAppReadAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  entries: NotificationHistoryItemDTO[];
  nextCursor: string | null;
}

/**
 * `listAll` (docs/ddd/notifications.md's own API Contract Sketch) — a
 * person's full notification history, read or unread, newest first.
 * Backed by `notification_recipient_created_idx`
 * (`(recipient_person_id, created_at DESC)`), the doc's own "general 'my
 * notification history' pagination, read or unread" index, alongside
 * `notification_unread_idx` which `listUnread` uses for the narrower
 * unread-only view. Same keyset-pagination shape as `listUnread` (ULID
 * `id` order agrees with `createdAt` order), just without the
 * `in_app_read_at IS NULL` filter.
 */
export async function listNotifications(prisma: PrismaClient, input: ListNotificationsInput): Promise<NotificationPage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.notification.findMany({
    where: {
      recipientPersonId: input.personId,
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
    inAppReadAt: row.inAppReadAt ? row.inAppReadAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));

  return { entries, nextCursor };
}
