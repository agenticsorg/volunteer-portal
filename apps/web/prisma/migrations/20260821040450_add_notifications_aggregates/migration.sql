-- Prisma's diff engine, run against this schema from this point on, always
-- misreads every prior phase's `GENERATED ALWAYS AS ... STORED` tsvector
-- columns (`community.post.search_vector`,
-- `training.course/module/video.search_vector`,
-- `volunteering.opportunities.search_vector`) as plain columns with a
-- default, and proposes dropping their default and their GIN index every
-- time — the exact same spurious diff already reproduced and declined once
-- per each of those migrations' own header comments in schema.prisma. The
-- generator emitted five `DROP INDEX` and five `ALTER COLUMN ... DROP
-- DEFAULT` statements here against `community`/`training`/`volunteering`
-- tables this migration has no other business touching; deliberately
-- removed from this hand-edited file — never applied, per that same
-- precedent — leaving only this migration's actual job: the `admin` cast
-- (also just a repeat of every prior migration's boilerplate) and the new
-- `notifications` schema objects below.

-- AlterTable
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
-- Notification invariants (docs/ddd/notifications.md): `channel` is the
-- *effective* channel set after preference gating ('email'|'in_app'|'both');
-- `source_context` records which schema's event triggered this notification
-- (including this context's own 'notifications' for internally-generated
-- reminders). `type` is deliberately plain text with no CHECK — an
-- application-enforced closed set (see this schema's own header comment in
-- schema.prisma), same convention as `identity.consent_record.purpose`.
CREATE TABLE "notifications"."notification" (
    "id" TEXT NOT NULL,
    "recipient_person_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "channel" TEXT NOT NULL,
    "in_app_read_at" TIMESTAMPTZ(6),
    "source_context" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_notification_channel" CHECK ("channel" IN ('email', 'in_app', 'both')),
    CONSTRAINT "chk_notification_source_context" CHECK ("source_context" IN
        ('volunteering', 'training', 'gamification', 'community', 'moderation', 'admin', 'notifications'))
);

-- CreateTable
-- NotificationPreference: one row per (person, type, channel) explicit
-- override; absence of a row means the type/channel's documented default
-- applies (packages/shared/src/notificationDefaults.ts, a later stage).
-- `channel` here is deliberately narrower than Notification's — a
-- preference is always per single channel, never 'both' (see this schema's
-- own Schema Sketch and its "NotificationPreference" ubiquitous-language
-- entry).
CREATE TABLE "notifications"."notification_preference" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_notification_preference_channel" CHECK ("channel" IN ('email', 'in_app'))
);

-- CreateTable
-- DeliveryAttempt: one row per attempt to deliver a Notification over one
-- channel. `in_app` delivery has no real "provider" and is created +
-- immediately marked `sent` in the same transaction as the Notification
-- write; `email` delivery starts `pending`, transitions via
-- `ProcessDeliveryJob` (a later stage) to `sent`/`failed`/`bounced`.
CREATE TABLE "notifications"."delivery_attempt" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_message_id" TEXT,
    "attempted_at" TIMESTAMPTZ(6),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_delivery_attempt_channel" CHECK ("channel" IN ('email', 'in_app')),
    CONSTRAINT "chk_delivery_attempt_status" CHECK ("status" IN ('pending', 'sent', 'failed', 'bounced'))
);

-- CreateTable
-- Idempotent inbound-event consumption ledger for the six per-source-schema
-- event-consumer jobs a later stage builds (ADR-0009) — added per this
-- stage's own explicit brief, not part of docs/ddd/notifications.md's own
-- Schema Sketch; see this schema's own header comment in schema.prisma for
-- the full reasoning. Keyed by a single `id` column (the origin
-- `domain_events.id`, a ULID, already globally unique on its own), same
-- shape as `community.processed_events`.
CREATE TABLE "notifications"."processed_events" (
    "id" TEXT NOT NULL,
    "source_context" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- General "my notification history" pagination, read or unread.
CREATE INDEX "notification_recipient_created_idx" ON "notifications"."notification"("recipient_person_id", "created_at" DESC);

-- CreateIndex
-- Idempotency: never queue the same notification twice for the same
-- recipient (Notification invariant 2).
CREATE UNIQUE INDEX "notification_source_event_recipient_uq" ON "notifications"."notification"("source_event_id", "recipient_person_id");

-- CreateIndex
CREATE INDEX "notification_preference_person_idx" ON "notifications"."notification_preference"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_person_id_type_channel_key" ON "notifications"."notification_preference"("person_id", "type", "channel");

-- CreateIndex
CREATE INDEX "delivery_attempt_notification_idx" ON "notifications"."delivery_attempt"("notification_id", "attempted_at" DESC);

-- AddForeignKey
ALTER TABLE "notifications"."delivery_attempt" ADD CONSTRAINT "delivery_attempt_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"."notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generates from schema.prisma — see this migration's own header comments
-- in schema.prisma for why each of these has no Prisma-schema-language
-- equivalent (partial indexes/uniques).
-- ---------------------------------------------------------------------------

-- "List my unread notifications" is the hottest read path in this schema
-- (Key Use Case 6, `ListUnread`). Partial on `in_app_read_at IS NULL` since
-- read notifications never appear in this query.
CREATE INDEX "notification_unread_idx"
  ON "notifications"."notification" ("recipient_person_id", "created_at" DESC)
  WHERE "in_app_read_at" IS NULL;

-- "List pending delivery jobs" — the graphile-worker drain query
-- `ProcessDeliveryJob` polls (Key Use Case 3). Partial on
-- `status = 'pending' AND channel = 'email'` since `in_app` attempts are
-- created already `sent` and never appear in this queue.
CREATE INDEX "delivery_attempt_pending_idx"
  ON "notifications"."delivery_attempt" ("created_at")
  WHERE "status" = 'pending' AND "channel" = 'email';

-- Resend webhook correlation (`HandleResendWebhook`, Key Use Case 7) —
-- looks up a `delivery_attempt` by `provider_message_id`. Partial (rather
-- than a plain unique) because `provider_message_id` is only ever set for
-- `email` attempts once Resend accepts the send; `in_app` attempts and
-- not-yet-sent `email` attempts leave it NULL.
CREATE UNIQUE INDEX "delivery_attempt_provider_message_uq"
  ON "notifications"."delivery_attempt" ("provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
