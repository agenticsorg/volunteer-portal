import type { PrismaClient } from "@prisma/client";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  getNotificationTypeDefault,
  type NotificationChannel,
  type NotificationType,
} from "@volunteer-portal/shared";

export interface ListPreferencesInput {
  personId: string;
}

export interface NotificationPreferenceDTO {
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  /** True when no explicit `notification_preference` row exists for this (type, channel) — `enabled` is the platform default, not a choice this person made. */
  isDefault: boolean;
  updatedAt: string | null;
}

/**
 * `listPreferences` (docs/ddd/notifications.md's own API Contract Sketch) —
 * the read half of Key Use Case 2 (`SetNotificationPreference`), not itself
 * a separately numbered Key Use Case. Returns the FULL (type, channel)
 * matrix — every closed notification type crossed with both channels, not
 * just the rows that happen to exist in `notification_preference` — so a
 * settings page can render every togglable row even before a person has
 * ever changed anything: `NotificationPreference`'s own doc comment,
 * verbatim, "Absence of a row means the type/channel's documented default
 * applies."
 *
 * Reuses `getNotificationTypeDefault` — the same default table
 * `getEffectivePreference` reads for both consent gates — so this list is
 * provably the same "is this on" answer `QueueNotification`/
 * `ProcessDeliveryJob` would compute for that (person, type, channel), never
 * a second, independently-drifting definition of the default.
 */
export async function listPreferences(prisma: PrismaClient, input: ListPreferencesInput): Promise<NotificationPreferenceDTO[]> {
  const rows = await prisma.notificationPreference.findMany({
    where: { personId: input.personId },
  });

  const explicit = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    explicit.set(`${row.type}:${row.channel}`, row);
  }

  const result: NotificationPreferenceDTO[] = [];
  for (const type of NOTIFICATION_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const row = explicit.get(`${type}:${channel}`);
      if (row) {
        result.push({ type, channel, enabled: row.enabled, isDefault: false, updatedAt: row.updatedAt.toISOString() });
      } else {
        result.push({ type, channel, enabled: getNotificationTypeDefault(type, channel), isDefault: true, updatedAt: null });
      }
    }
  }
  return result;
}
