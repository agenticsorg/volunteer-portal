-- Phase 9 — Admin & Reporting: admin.retention_policies + admin.processed_events.
--
-- admin.report_definition / admin.export_job already exist as of the prior
-- migration (20260821050908_add_admin_reporting_aggregates). This migration
-- adds the two tables that stage's own header comment deliberately deferred:
-- admin.retention_policies (ADR-0014 §3 — "left for whichever later stage
-- actually builds the retention_sweep job") and admin.processed_events
-- (this schema's own idempotency ledger for consumeIdentityDsarEvents, the
-- same single-consumer-per-source-schema shape notifications.processed_events
-- already established).

-- CreateTable
CREATE TABLE "admin"."retention_policies" (
    "id" TEXT NOT NULL,
    "data_class" TEXT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_retention_policies_action" CHECK ("action" IN ('anonymize', 'hard_delete'))
);

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_data_class_key" ON "admin"."retention_policies"("data_class");

-- CreateTable
CREATE TABLE "admin"."processed_events" (
    "id" TEXT NOT NULL,
    "source_context" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- Seed defaults, ADR-0014 §3's exact literal values:
-- "inactive_volunteer_pii = 730 days since last login -> anonymize;
--  video_watch_events = 365 days -> hard_delete (raw event granularity;
--  aggregated completion state is retained separately as it's needed for
--  certificates); moderation_logs = 1095 days (3 years) -> anonymize actor
--  references, retain action/reason; dsar_export_bundles = 7 days ->
--  hard_delete (R2 lifecycle rule mirrors this); session_tokens = 30 days
--  past expiry -> hard_delete."
INSERT INTO "admin"."retention_policies" ("id", "data_class", "retention_days", "action", "enabled") VALUES
    ('3BHCSR06XJDYPMPW3V96T54GNT', 'inactive_volunteer_pii', 730, 'anonymize', true),
    ('HKGEG4JJH2AQ13H3P18GWNKPZ8', 'video_watch_events', 365, 'hard_delete', true),
    ('P1Q63KAQK276KZ5D1YPAJHKJQT', 'moderation_logs', 1095, 'anonymize', true),
    ('DN7DH2GYBEQHQFJWV073YT5FXV', 'dsar_export_bundles', 7, 'hard_delete', true),
    ('QHD05RA3XTY7579WJH8ER0Y0YM', 'session_tokens', 30, 'hard_delete', true);
