# Notifications

## Purpose & Scope

The `notifications` bounded context is the single place in the Volunteer Portal where "something happened elsewhere in the system, and a person needs to be told about it" becomes an actual email or in-app alert. It owns no business data of its own — it does not know what an hour entry is, what a badge means, or what a moderation ladder looks like. It only knows how to turn an external domain event into a `Notification`, check whether the recipient wants to receive it, and deliver it through the channel(s) they've allowed.

This context is deliberately a **universal consumer**: every other bounded context (`volunteering`, `training`, `gamification`, `community`, `moderation`, `admin`) publishes domain events to its own `domain_events` outbox, and `notifications` is the one context expected to eventually subscribe to all of them. It never writes back into another schema and never blocks another context's transaction — a slow or failed notification never rolls back the business event that caused it.

In scope:
- Translating external domain events into `Notification` rows, gated by per-person, per-type, per-channel preferences.
- Sending transactional email via Resend and recording in-app notification state (read/unread).
- Tracking delivery outcome per channel (`DeliveryAttempt`) including provider message IDs and retries.
- Letting a person manage their own notification preferences, which is also this context's enforcement point for the consent overlap identified in `docs/research/05-domain-and-compliance.md` (a person opting out of "leaderboard participation" consent in `identity` must, in practice, also be able to opt out of leaderboard-related notifications here).

Out of scope: consent-of-record itself (owned by `identity.consent_record`), the business logic that decides *whether* an hour was approved or a badge was earned (owned by the emitting context), and templated marketing/newsletter campaign management (not part of this platform's v1).

## Ubiquitous Language

| Term | Definition |
|---|---|
| Notification | A single message queued for one recipient, generated from exactly one triggering event, deliverable over one or more channels. |
| Notification Type | A closed, application-enforced set of reasons a notification exists (e.g. `hours_approved`, `badge_awarded`). Not a DB enum, to avoid a migration every time a new source event is wired up — same convention as `identity.consent_record.purpose` (ADR-0014). |
| Channel | Where a notification can be delivered: `email`, `in_app`, or `both`. |
| Recipient | The `identity.person` (by ID only, no FK) who receives the notification. |
| NotificationPreference | A person's standing opt-in/opt-out choice for a given (type, channel) pair. Absence of a row means the type/channel's documented default applies. |
| DeliveryAttempt | A child record of a `Notification` tracking one attempt to deliver it over one channel: pending, sent, failed, or bounced. |
| Provider Message ID | The Resend-assigned message ID for an email delivery attempt, used to correlate delivery/bounce webhooks back to the attempt. |
| Read State | For `in_app` notifications only: whether and when the recipient has viewed it (`in_app_read_at`). Email notifications have no read state in this schema — Resend's open-tracking is not modeled here. |
| Source Event | The external domain event (from another schema's outbox) that caused a `Notification` to be queued. Recorded for idempotency and traceability, never re-interpreted after the fact. |
| Event Handler | A per-source-event-type translation function that maps an external event's payload into a `QueueNotification` command. See Integration & Anti-Corruption Notes. |
| Suppressed Notification | A would-be notification that is never persisted because every requested channel is opted out for that person/type at queue time. Not an error — a normal, silent outcome. |

## Aggregates, Entities & Value Objects

### `Notification` (aggregate root)
The unit of "this person needs to know X." One `Notification` is created per (recipient, source event), never mutated except for `in_app_read_at`.

- `id` — ULID.
- `recipientPersonId` — `identity.person.id`, by ID only, no FK.
- `type` — notification type (closed application-level set; see below).
- `payload` — structured JSON carrying everything the notification template needs to render (e.g. `{ hourEntryId, opportunityTitle, hours, approvedBy }`), so rendering never needs a live cross-context lookup at send time.
- `channel` — the *effective* channel(s) this notification was queued for, after preference gating (`email` | `in_app` | `both`). This is not the same as the source event's requested default channel — see invariant below.
- `inAppReadAt` — nullable timestamp; null means unread. Only meaningful when `channel` includes `in_app`.
- `sourceContext` — which schema's event triggered this (`volunteering` | `training` | `gamification` | `community` | `moderation` | `admin`).
- `sourceEventId` — the ULID of the external `domain_events` row that caused this notification, used for de-duplication.
- `createdAt`.

**Notification types (application-enforced closed set, extendable without a migration):** `hours_approved`, `badge_awarded`, `streak_broken`, `training_reminder`, `course_completed`, `certificate_issued`, `moderation_action`, `mention`, `kudos_given`, `mentorship_started`, `export_ready`.

**Hard invariants:**
1. **A `Notification` is never created, and never delivered, for a (person, type, channel) combination the person has opted out of.** This is the consent-enforcement point called out in the research: notification preferences and consent purposes overlap (e.g. `leaderboard_participation` consent and `badge_awarded`/leaderboard-adjacent notification types), and this invariant is the code path that makes an opt-out actually stick, not just a UI toggle that only affects the settings page. Concretely: `QueueNotification` computes an *effective channel set* = requested channels ∩ enabled preferences at queue time; if the resulting set is empty, **no `Notification` row is created at all** (a suppressed notification, not a failed one). `ProcessDeliveryJob` re-checks the preference for the specific channel immediately before contacting Resend or writing the in-app read-state row, as a defense-in-depth check against preferences changing in the (typically seconds-long) window between queue and delivery.
2. **Idempotent by source event.** `(sourceEventId, recipientPersonId)` is unique — redelivery of the same upstream event (graphile-worker's at-least-once semantics) must never produce a duplicate notification.
3. A `Notification`'s `payload` is immutable once created — it is a snapshot of the triggering event, not a live view. If the underlying entity changes later (e.g. an hour entry gets un-approved, which is out of scope for volunteering per its own invariants), the notification is not retroactively edited.

### `NotificationPreference` (entity)
One row per (person, type, channel). Governs whether `QueueNotification` includes that channel in the effective set for that person and type.

- `id` — ULID.
- `personId` — `identity.person.id`.
- `type` — notification type.
- `channel` — `email` | `in_app` (never `both` — preferences are always per single channel; `Notification.channel` can be `both` as the union of two preference rows both being enabled).
- `enabled` — boolean.
- `updatedAt`.

**Default behavior when no row exists** (so the system is usable before a person ever visits the settings page): operational/transactional types (`hours_approved`, `certificate_issued`, `moderation_action`, `export_ready`) default **enabled** on both channels. Social/engagement types (`badge_awarded`, `streak_broken`, `training_reminder`, `mention`, `kudos_given`, `mentorship_started`) default **enabled** for `in_app`, **enabled** for `email` — but for `course_completed` email defaults to **disabled** (in-app only) to avoid inbox noise for a routine event a person will see in-app anyway. This default table is application config (`packages/shared/src/notificationDefaults.ts`), not hardcoded per call site, so it can change without touching handler code. A person's explicit `NotificationPreference` row always wins over the default.

### `DeliveryAttempt` (entity, child of `Notification`)
One row per attempt to deliver a `Notification` over one channel. A `Notification` with `channel = 'both'` produces two independent `DeliveryAttempt` lineages (one per channel), each with its own retry history.

- `id` — ULID.
- `notificationId` — FK to `notification.id` (same schema — ordinary FK is fine within a bounded context per ADR-0001).
- `channel` — `email` | `in_app`.
- `status` — `pending` | `sent` | `failed` | `bounced`.
- `providerMessageId` — Resend's message ID (nullable; only set for `email` once Resend accepts the send).
- `attemptedAt` — nullable timestamp of the most recent attempt.
- `retryCount` — integer, incremented on each `failed` retry.
- `errorMessage` — nullable, last error detail.
- `createdAt`.

**Invariants:**
- `in_app` delivery has no real "provider" — writing the `notification` row (with `channel` including `in_app`) *is* the delivery. Its `DeliveryAttempt` is created and immediately marked `sent` in the same transaction, with `attemptedAt = createdAt`. This keeps "list unread" simple (it's just `notification.in_app_read_at IS NULL`) while still giving in-app delivery a uniform audit trail alongside email.
- `email` delivery starts `pending`, is picked up by `ProcessDeliveryJob`, and transitions to `sent` (Resend accepted it), `failed` (Resend rejected it or the call errored — eligible for retry up to a configured max, e.g. 5, with exponential backoff via graphile-worker's native retry), or `bounced` (a later Resend webhook reports a hard bounce/complaint against a `providerMessageId` that was previously `sent`).
- `bounced` is a terminal state reachable only from `sent`, never retried automatically — a bounced address needs human or automated suppression-list handling, out of scope for this schema's v1 beyond recording the fact.

## Domain Events

### Published (this context's own outbox: `notifications.domain_events`)

| Event | Emitted When | Payload Highlights |
|---|---|---|
| `NotificationQueued` | A `Notification` row is created (after preference gating). | `notificationId`, `recipientPersonId`, `type`, `channel` |
| `NotificationDelivered` | A `DeliveryAttempt` transitions to `sent` (per channel). | `notificationId`, `deliveryAttemptId`, `channel`, `providerMessageId` |
| `NotificationFailed` | A `DeliveryAttempt` exhausts retries and lands in `failed`, or transitions to `bounced`. | `notificationId`, `deliveryAttemptId`, `channel`, `status`, `errorMessage` |

These are consumed internally (e.g. an admin observability dashboard, or a future "notify me if my export email bounced" loop) but no other bounded context currently depends on them — this context is overwhelmingly a *consumer*, not a producer, in the platform's event graph.

### Consumed (external events from every other context's outbox — this context is a universal consumer)

| Source Context | Event | Resulting Notification Type |
|---|---|---|
| `volunteering` | `HoursApproved` | `hours_approved` |
| `gamification` | `BadgeAwarded` | `badge_awarded` |
| `gamification` | `StreakBroken` | `streak_broken` |
| `training` | `CourseCompleted` | `course_completed` |
| `training` | `CertificateIssued` | `certificate_issued` |
| `community` | `KudosGiven` | `kudos_given` |
| `community` | `MentorshipStarted` | `mentorship_started` |
| `community` | `MentionCreated` | `mention` |
| `moderation` | `ModerationActionTaken` | `moderation_action` |
| `admin` | `ExportJobCompleted` | `export_ready` |

`training_reminder` has no external trigger — it is generated by this context's own scheduled graphile-worker job (`scanTrainingReminders`, run daily) that reads (read-only, via `training`'s published `index.ts` query function, never a cross-schema join) enrollments approaching a deadline and calls `QueueNotification` directly, exactly as if it were reacting to an event. This table is not closed: adding a new consumed event type is additive (a new handler file + one row in the type-default config), never a schema change to this context's own tables, because `payload` is JSONB and `sourceContext`/`type` are open text values.

## Key Use Cases / Application Services

1. **`QueueNotification(command)`** *(internal — never called directly by an API client, only by event handlers and the reminder scheduler)*. Input: `{ recipientPersonId, type, requestedChannels, payload, sourceContext, sourceEventId }`. Loads effective preferences for `recipientPersonId` × `type` across the requested channels; computes the effective channel set; if empty, no-ops (suppressed); otherwise inserts `notification` + one `delivery_attempt` per effective channel (in_app immediately `sent`, email `pending`) + a `NotificationQueued` outbox row, all in one transaction. Idempotent on `(sourceEventId, recipientPersonId)`.
2. **`SetNotificationPreference({ personId, type, channel, enabled })`** — upserts a `notification_preference` row (unique on `personId, type, channel`). Called from the person's own notification settings page; a person may only set their own preferences (enforced by `can()`, ADR-0007).
3. **`ProcessDeliveryJob(deliveryAttemptId)`** — the graphile-worker job that performs actual delivery for `pending` email `delivery_attempt` rows. Re-checks the live preference for (recipient, type, `email`) as a final gate; if now disabled, marks the attempt `failed` with `errorMessage = 'preference_revoked'` and does **not** call Resend. Otherwise calls Resend's send API with the rendered template for `notification.type`, records `providerMessageId`, sets `status = 'sent'`, `attemptedAt = now()`, and writes `NotificationDelivered`. On a Resend error, increments `retryCount`, sets `status = 'failed'`, writes `NotificationFailed`, and lets graphile-worker's native retry/backoff re-invoke the job up to the configured max attempts.
4. **`MarkAsRead({ personId, notificationId })`** — sets `in_app_read_at = now()` on a `notification` row owned by `personId`. Idempotent (marking an already-read notification as read is a no-op, not an error).
5. **`MarkAllAsRead({ personId })`** — bulk variant of the above for every unread `in_app`-channel notification belonging to `personId`.
6. **`ListUnread({ personId, cursor?, limit })`** — cursor-paginated list of `notification` rows for `personId` where `channel` includes `in_app` and `in_app_read_at IS NULL`, newest first.
7. **`HandleResendWebhook(event)`** *(internal, called by the REST webhook receiver)* — looks up the `delivery_attempt` by `providerMessageId` and transitions `sent → bounced` on a `bounce`/`complaint` event; ignored (logged, not errored) if the `providerMessageId` is unknown (e.g. a delivery attempt from a different environment).

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE notifications.notification (
  id                    TEXT PRIMARY KEY,                 -- ULID
  recipient_person_id   TEXT NOT NULL,                     -- identity.person.id, no FK
  type                  TEXT NOT NULL,                     -- closed app-level set, see Aggregates
  payload               JSONB NOT NULL DEFAULT '{}',
  channel               TEXT NOT NULL
                          CHECK (channel IN ('email','in_app','both')),
  in_app_read_at        TIMESTAMPTZ,                       -- null = unread; only meaningful if channel includes in_app
  source_context        TEXT NOT NULL
                          CHECK (source_context IN
                            ('volunteering','training','gamification','community','moderation','admin','notifications')),
  source_event_id       TEXT NOT NULL,                     -- ULID of the external domain_events row
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: never queue the same notification twice for the same recipient.
CREATE UNIQUE INDEX notification_source_event_recipient_uq
  ON notifications.notification (source_event_id, recipient_person_id);

-- "List my unread notifications" is the hottest read path in this schema.
CREATE INDEX notification_unread_idx
  ON notifications.notification (recipient_person_id, created_at DESC)
  WHERE in_app_read_at IS NULL;

-- General "my notification history" pagination, read or unread.
CREATE INDEX notification_recipient_created_idx
  ON notifications.notification (recipient_person_id, created_at DESC);

CREATE TABLE notifications.notification_preference (
  id           TEXT PRIMARY KEY,                            -- ULID
  person_id    TEXT NOT NULL,                                -- identity.person.id, no FK
  type         TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('email','in_app')),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, type, channel)
);

CREATE INDEX notification_preference_person_idx
  ON notifications.notification_preference (person_id);

CREATE TABLE notifications.delivery_attempt (
  id                   TEXT PRIMARY KEY,                    -- ULID
  notification_id      TEXT NOT NULL REFERENCES notifications.notification(id),
  channel              TEXT NOT NULL CHECK (channel IN ('email','in_app')),
  status               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','failed','bounced')),
  provider_message_id  TEXT,                                 -- Resend message ID, email only
  attempted_at         TIMESTAMPTZ,
  retry_count          INT NOT NULL DEFAULT 0,
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "List pending delivery jobs" — the graphile-worker drain query for email sends.
CREATE INDEX delivery_attempt_pending_idx
  ON notifications.delivery_attempt (created_at)
  WHERE status = 'pending' AND channel = 'email';

-- Resend webhook correlation.
CREATE UNIQUE INDEX delivery_attempt_provider_message_uq
  ON notifications.delivery_attempt (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX delivery_attempt_notification_idx
  ON notifications.delivery_attempt (notification_id, attempted_at DESC);

-- This schema's own transactional outbox.
CREATE TABLE notifications.domain_events (
  id            TEXT PRIMARY KEY,                            -- ULID
  aggregate_id  TEXT NOT NULL,                                -- notification.id
  event_type    TEXT NOT NULL,                                -- 'NotificationQueued' | 'NotificationDelivered' | 'NotificationFailed'
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX domain_events_unprocessed_idx
  ON notifications.domain_events (id)
  WHERE processed_at IS NULL;
```

## API Contract Sketch

This context has no public `/api/v1` surface of its own beyond the Resend webhook receiver — all person-facing operations are internal tRPC procedures, and Resend is an outbound integration, not an inbound one this context exposes to other bounded contexts.

```typescript
// apps/web/src/modules/notifications/api/trpc/router.ts
export const notificationsRouter = router({
  listUnread: protectedProcedure
    .input(z.object({
      cursor: ulidSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ ctx, input }) =>
      listUnread({ personId: ctx.subject.personId, ...input })),

  listAll: protectedProcedure
    .input(z.object({ cursor: ulidSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) =>
      listNotifications({ personId: ctx.subject.personId, ...input })),

  markAsRead: protectedProcedure
    .input(z.object({ notificationId: ulidSchema }))
    .mutation(async ({ ctx, input }) =>
      markAsRead({ personId: ctx.subject.personId, notificationId: input.notificationId })),

  markAllAsRead: protectedProcedure
    .mutation(async ({ ctx }) => markAllAsRead({ personId: ctx.subject.personId })),

  listPreferences: protectedProcedure
    .query(async ({ ctx }) => listPreferences({ personId: ctx.subject.personId })),

  setPreference: protectedProcedure
    .input(z.object({
      type: notificationTypeSchema,
      channel: z.enum(['email', 'in_app']),
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) =>
      setNotificationPreference({ personId: ctx.subject.personId, ...input })),
});
```

```typescript
// apps/web/app/api/webhooks/resend/route.ts — inbound, not versioned under /api/v1
// since it is a provider webhook receiver, not a public API contract this platform owns.
// Verifies the Resend webhook signature (svix-style HMAC header) before processing,
// then calls handleResendWebhook(event) — see Use Case 7.
```

## Integration & Anti-Corruption Notes

**Generic event-handler-per-source-event-type pattern.** Each external event type this context consumes gets one small, isolated handler file under `modules/notifications/application/handlers/<sourceContext>/<eventType>.ts`, registered in a lookup table (`eventType -> handler`). A handler's only job is a pure translation: read the external event's `payload` (already JSON, already validated by the producing schema before it wrote its own outbox row) and produce a `QueueNotification` command — it never calls back into the source schema to fetch more data, so the notification payload must contain everything needed to render (this is why, e.g., `HoursApproved`'s payload includes `opportunityTitle` as a denormalized string rather than notifications having to look up `volunteering.opportunity` by ID). This is the anti-corruption layer: the *shape* of `HoursApproved` or `BadgeAwarded` never leaks past its one handler file into the rest of this context's domain model, which only ever deals in `Notification`, `NotificationPreference`, and `DeliveryAttempt`.

**How consumption actually happens (mechanics).** A graphile-worker job per source schema (e.g. `consumeVolunteeringEvents`, `consumeGamificationEvents`) polls that schema's `domain_events` table (`WHERE processed_at IS NULL ORDER BY id LIMIT 100`, per the pattern already established for `training.domain_events` in ADR-0010) using a read-scoped Prisma client for that schema. This is a controlled read of the one table every schema explicitly publishes as its integration surface — the `domain_events` outbox — never any other table in that schema, and never a SQL join across schemas. It is the mechanical embodiment of the "prefer domain events over direct calls" guidance in ADR-0001; the only thing crossing the schema boundary is an already-serialized, already-committed fact. After translation and `QueueNotification`, the consumer job marks the source row `processed_at = now()` (in the *source* schema — each source schema's outbox-drain contract includes granting the notifications consumer job update rights on that one column, same as every other outbox consumer in the system, e.g. `audit_log_writer` in ADR-0014).

**Consent/preference gating happens before Resend is ever called — twice.** The first gate is at `QueueNotification` time (Use Case 1): if every requested channel is opted out, nothing is persisted at all — there is no `Notification` row to later "fail," because failure implies an attempt was made, and an opted-out person should see zero evidence a notification was even considered. The second gate is at `ProcessDeliveryJob` time (Use Case 3), immediately before the Resend API call: because queueing and delivery are asynchronous (a graphile-worker poll interval apart, typically seconds), a person could revoke a preference in that window, and the job must not deliver based on stale state. Both gates read `notification_preference`, never `identity.consent_record` directly — this context does not reach into `identity`'s schema. Where a notification type maps onto a GDPR consent purpose owned by `identity` (e.g. `badge_awarded`/leaderboard-adjacent types and the `leaderboard_participation` purpose), the mapping is enforced upstream, at the point `identity` or `gamification` decides whether to emit the triggering event in the first place (e.g. `gamification` does not emit `BadgeAwarded` for a person who has not consented to leaderboard participation) — `notifications` only ever sees events it is already safe to *notify about*; its own preference layer is a second, independent, notification-specific opt-out on top of that (a person may consent to leaderboard participation but still not want an email every time they earn a badge).

**No cross-schema writes, ever.** This context's consumer jobs only ever write to `notifications.*` tables and to the single `processed_at` column of a source schema's own `domain_events` row (a narrow, explicitly-granted exception that exists for every outbox consumer in the system, not unique to notifications). It never writes a `notification_id` back onto the source event or otherwise couples the source schema to the fact that a notification resulted from it.
