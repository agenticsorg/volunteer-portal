/**
 * `notifications`' per-type default preferences and delivery cadence
 * (docs/ddd/notifications.md, `NotificationPreference`'s own doc comment:
 * "This default table is application config
 * (`packages/shared/src/notificationDefaults.ts`), not hardcoded per call
 * site, so it can change without touching handler code"). Lives in its own
 * package, outside `apps/web/src/modules/notifications/**`, specifically so
 * a future second consumer (an admin-facing "what are the platform
 * defaults" screen, a digest-batching worker) can read it without going
 * through `notifications`' own module boundary for a value that isn't
 * really `notifications`-internal state — it's shared, static config.
 *
 * The closed notification-type set mirrors docs/ddd/notifications.md's own
 * "Notification types (application-enforced closed set, extendable without
 * a migration)" list verbatim — deliberately NOT a Postgres enum, matching
 * `identity.consent_record.purpose`'s own precedent (ADR-0014), so wiring
 * up a new source event only ever needs a new handler file plus one row
 * here, never a migration.
 */

export const NOTIFICATION_TYPES = [
  "hours_approved",
  "badge_awarded",
  "streak_broken",
  "training_reminder",
  "course_completed",
  "certificate_issued",
  "moderation_action",
  "mention",
  "kudos_given",
  "mentorship_started",
  "export_ready",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** `NotificationPreference.channel` / one entry of `Notification.channel`'s union — never `'both'` here, see that field's own doc comment. */
export const NOTIFICATION_CHANNELS = ["email", "in_app"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Default `enabled` state per (type, channel) when no explicit
 * `NotificationPreference` row exists — docs/ddd/notifications.md's
 * `NotificationPreference` doc comment, verbatim: operational/transactional
 * types default enabled on both channels; social/engagement types default
 * enabled on both channels EXCEPT `course_completed`, whose email defaults
 * to disabled (in-app only, "to avoid inbox noise for a routine event a
 * person will see in-app anyway"). A person's explicit preference row
 * always wins over this table — see `getEffectivePreference` in the
 * `notifications` module, the only reader of this table.
 */
export const NOTIFICATION_TYPE_DEFAULTS: Record<NotificationType, Record<NotificationChannel, boolean>> = {
  // Operational/transactional — always enabled on both channels by default.
  hours_approved: { email: true, in_app: true },
  certificate_issued: { email: true, in_app: true },
  moderation_action: { email: true, in_app: true },
  export_ready: { email: true, in_app: true },
  // Social/engagement — enabled on both channels by default...
  badge_awarded: { email: true, in_app: true },
  streak_broken: { email: true, in_app: true },
  training_reminder: { email: true, in_app: true },
  mention: { email: true, in_app: true },
  kudos_given: { email: true, in_app: true },
  mentorship_started: { email: true, in_app: true },
  // ...except course_completed, whose email defaults OFF (in-app only).
  course_completed: { email: false, in_app: true },
};

export function getNotificationTypeDefault(type: NotificationType, channel: NotificationChannel): boolean {
  return NOTIFICATION_TYPE_DEFAULTS[type][channel];
}

/**
 * Each notification type's nominal delivery cadence — real-time (fires
 * immediately off the triggering event, the only mode `notifications`'
 * `ProcessDeliveryJob` actually executes in this phase) or digest
 * (accumulated for a future batched-send job). Every type is `"realtime"`
 * today: docs/ddd/notifications.md's own Key Use Cases (1–7) describe only
 * an immediate-send `ProcessDeliveryJob`, with no digest-accumulation
 * state anywhere in its Schema Sketch and no `sendDigestEmails`-equivalent
 * use case — unlike ADR-0012's own earlier, fuller sketch (`digest_frequency`
 * on `notifications.preferences`), which docs/ddd/notifications.md's actual
 * `NotificationPreference` shape does not carry forward. This table exists
 * so "a digest-vs-real-time delivery setting per notification type" is a
 * real, per-type, application-config value a future batching worker can
 * read — the same "config, not a later schema change" shape this file's
 * channel defaults already use — without that worker needing a schema
 * change of its own to know which types it's allowed to batch.
 */
export type NotificationDeliveryMode = "realtime" | "digest";

export const NOTIFICATION_TYPE_DELIVERY_MODE: Record<NotificationType, NotificationDeliveryMode> = {
  hours_approved: "realtime",
  badge_awarded: "realtime",
  streak_broken: "realtime",
  training_reminder: "realtime",
  course_completed: "realtime",
  certificate_issued: "realtime",
  moderation_action: "realtime",
  mention: "realtime",
  kudos_given: "realtime",
  mentorship_started: "realtime",
  export_ready: "realtime",
};

export function getNotificationTypeDeliveryMode(type: NotificationType): NotificationDeliveryMode {
  return NOTIFICATION_TYPE_DELIVERY_MODE[type];
}
