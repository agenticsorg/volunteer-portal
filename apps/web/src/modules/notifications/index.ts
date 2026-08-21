/**
 * notifications bounded-context module — public interface.
 *
 * Notifications — delivery of email/in-app/push notifications, per-channel
 * preferences, driven entirely by consuming other contexts' domain events.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 8 scope, this stage: the domain/application layer only — every
 * aggregate/invariant/Key Use Case from docs/ddd/notifications.md
 * (Notification, NotificationPreference, DeliveryAttempt), the eight
 * source-event handlers docs/plans/implementation-plan.md's Phase 8 Build
 * item 2 names (`HoursApproved`, `BadgeAwarded`, `StreakBroken`,
 * `CourseCompleted`, `CertificateIssued`, `KudosGiven`,
 * `MentorshipStarted`, `ModerationActionTaken`), the double-gated consent
 * check (`QueueNotification`'s QUEUE-TIME gate and `ProcessDeliveryJob`'s
 * independent DELIVERY-TIME gate — both read `getEffectivePreference`
 * fresh, never a cached/reused decision), the Resend adapter boundary
 * (`infra/resendClient.ts` — this environment has no `RESEND_API_KEY`, so
 * `sendTransactionalEmail` genuinely throws
 * `ExternalServiceNotConfiguredError` rather than faking a send), and the
 * in-app notification center (read/unread state via `MarkAsRead`/
 * `MarkAllAsRead`/`ListUnread`).
 *
 * A later stage (the API layer) added the tRPC router
 * (`server/api/routers/notifications.ts`, per docs/ddd/notifications.md's
 * API Contract Sketch) plus two thin read-only queries that sketch names but
 * the domain/application stage didn't build yet — `listNotifications`
 * (`listAll`) and `listPreferences` — exported alongside every other
 * use case below.
 *
 * Still NOT in this module (a later stage's job, same split every other
 * module's `index.ts` header already documents for its own event-relay
 * worker): the REST webhook receiver (`app/api/webhooks/resend/route.ts`),
 * and the graphile-worker tasks that poll each source schema's
 * `domain_events` table and call this module's five `consume*Events`
 * functions per row, or that schedule `ProcessDeliveryJob` for newly-
 * `pending` email `delivery_attempt` rows — this module exports the fully-
 * idempotent consumer/delivery logic those tasks will call, not the
 * polling/scheduling mechanism itself.
 */

// --- Inbound event consumption (ADR-0009) — one job per source schema ---
export { consumeVolunteeringEvents } from "./application/consumeVolunteeringEvents";
export { consumeGamificationEvents } from "./application/consumeGamificationEvents";
export { consumeTrainingEvents } from "./application/consumeTrainingEvents";
export { consumeCommunityEvents } from "./application/consumeCommunityEvents";
export { consumeModerationEvents } from "./application/consumeModerationEvents";
export type { ConsumeEventResult } from "./application/consumeVolunteeringEvents";

/** Individual handlers — exported alongside their `consume*Events` dispatcher for direct unit testing, same precedent as every other module's own `handle*` exports. */
export { handleHoursApproved } from "./application/handlers/volunteering/hoursApproved";
export { handleBadgeAwarded } from "./application/handlers/gamification/badgeAwarded";
export { handleStreakBroken } from "./application/handlers/gamification/streakBroken";
export { handleCourseCompleted } from "./application/handlers/training/courseCompleted";
export { handleCertificateIssued } from "./application/handlers/training/certificateIssued";
export { handleKudosGiven } from "./application/handlers/community/kudosGiven";
export { handleMentorshipStarted } from "./application/handlers/community/mentorshipStarted";
export { handleModerationActionTaken } from "./application/handlers/moderation/moderationActionTaken";
export type { ConsumptionResult } from "./application/idempotentConsumption";

export {
  INBOUND_EVENT_TYPES,
  isInboundEventType,
} from "./domain/inboundEvents";
export type {
  InboundEvent,
  InboundEventType,
  SourceContext,
  HoursApprovedPayload,
  BadgeAwardedPayload,
  StreakBrokenPayload,
  CourseCompletedPayload,
  CertificateIssuedPayload,
  KudosGivenPayload,
  MentorshipStartedPayload,
  ModerationActionTakenPayload,
} from "./domain/inboundEvents";

// --- QueueNotification (Key Use Case 1) — internal, but exported for direct unit testing, same as every handler above ---
export { queueNotification } from "./application/queueNotification";
export type { QueueNotificationCommand, QueueNotificationResult } from "./application/queueNotification";

export { getEffectivePreference } from "./application/getEffectivePreference";

// --- Preferences (Key Use Case 2) ---
export { setNotificationPreference } from "./application/setNotificationPreference";
export type { SetNotificationPreferenceInput, SetPreferenceResult } from "./application/setNotificationPreference";

// --- Delivery (Key Use Case 3) ---
export { processDeliveryJob } from "./application/processDeliveryJob";
export type { ProcessDeliveryJobOutcome, ProcessDeliveryJobResult } from "./application/processDeliveryJob";

export { renderNotificationEmail } from "./application/renderNotificationEmail";
export type { RenderedEmail } from "./application/renderNotificationEmail";

// --- In-app notification center (Key Use Cases 4–6) ---
export { markAsRead } from "./application/markAsRead";
export type { MarkAsReadInput, MarkedAsRead } from "./application/markAsRead";

export { markAllAsRead } from "./application/markAllAsRead";
export type { MarkAllAsReadInput, MarkedAllAsRead } from "./application/markAllAsRead";

export { listUnread } from "./application/listUnread";
export type { ListUnreadInput, NotificationListItemDTO, UnreadNotificationPage } from "./application/listUnread";

/** `listAll` (API Contract Sketch) — full notification history, read or unread; see this stage's own `listNotifications.ts` doc comment. */
export { listNotifications } from "./application/listNotifications";
export type { ListNotificationsInput, NotificationHistoryItemDTO, NotificationPage } from "./application/listNotifications";

/** `listPreferences` (API Contract Sketch) — the read half of Key Use Case 2; see this stage's own `listPreferences.ts` doc comment. */
export { listPreferences } from "./application/listPreferences";
export type { ListPreferencesInput, NotificationPreferenceDTO } from "./application/listPreferences";

// --- Resend webhook handling (Key Use Case 7) ---
export { handleResendWebhook } from "./application/handleResendWebhook";
export type { HandleResendWebhookResult, ResendWebhookEvent, ResendWebhookEventType } from "./application/handleResendWebhook";

// --- Infra (Resend adapter boundary) ---
export { resendAdapter } from "./infra/resendClient";
export type { ResendAdapter, ResendWebhookHeaders, SendTransactionalEmailInput, SendTransactionalEmailResult } from "./infra/resendClient";

// --- Notification-type vocabulary (closed set; re-exported from `@volunteer-portal/shared` for callers that only need the module's own barrel) ---
export {
  NOTIFICATION_TYPES,
  isNotificationType,
  NOTIFICATION_CHANNELS,
  getNotificationTypeDefault,
  getNotificationTypeDeliveryMode,
} from "@volunteer-portal/shared";
export type { NotificationType, NotificationChannel, NotificationDeliveryMode } from "@volunteer-portal/shared";

export {
  ForbiddenActionError,
  PersonNotFoundError,
  SourceRecordNotFoundError,
  NotificationNotFoundError,
  DeliveryAttemptNotFoundError,
  DeliveryAttemptNotEmailChannelError,
  ExternalServiceNotConfiguredError,
} from "./domain/errors";
