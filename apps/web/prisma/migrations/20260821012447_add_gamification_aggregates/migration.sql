/*
  Warnings:

  - You are about to alter the column `ip_address` on the `audit_log` table. The data in that column could be lost. The data in that column will be cast from `Inet` to `Unsupported("inet")`.

*/
-- CreateEnum
CREATE TYPE "gamification"."streak_status" AS ENUM ('active', 'frozen', 'broken');

-- CreateEnum
CREATE TYPE "gamification"."leaderboard_scope_type" AS ENUM ('team', 'challenge');

-- AlterTable
--
-- Prisma's diff engine also proposed, ahead of this comment, a
-- `DROP INDEX "training"."idx_course_search"`, `DROP INDEX
-- "training"."idx_module_search"`, `DROP INDEX
-- "training"."idx_video_search"`, `DROP INDEX
-- "volunteering"."idx_opportunities_search"`, and matching `ALTER TABLE ...
-- ALTER COLUMN "search_vector" DROP DEFAULT` statements for
-- `training.course`/`training.module`/`training.video`/
-- `volunteering.opportunities` — all stripped from this migration. This is
-- the same known false-diff already documented in schema.prisma's
-- `Opportunity`/`Course`/`Module`/`Video` model comments and already
-- declined once before in the Phase 4 training migration (see that
-- migration's own header comment): Prisma's migrate-diff engine cannot
-- fully round-trip a `GENERATED ALWAYS AS ... STORED` column it only sees
-- as `Unsupported("tsvector")`. Applying either statement would drop
-- working full-text-search infrastructure with no corresponding
-- schema.prisma change to justify it. Declined again here per those
-- models' own instruction to decline this exact set every time it
-- resurfaces.
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
CREATE TABLE "gamification"."points_ledger_entry" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "source_event_type" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification"."points_balance" (
    "person_id" TEXT NOT NULL,
    "total_points" BIGINT NOT NULL DEFAULT 0,
    "last_ledger_entry_id" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_balance_pkey" PRIMARY KEY ("person_id")
);

-- CreateTable
CREATE TABLE "gamification"."badge" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon_url" TEXT,
    "criteria" JSONB NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification"."badge_award" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "badge_id" TEXT NOT NULL,
    "source_event_id" TEXT,
    "awarded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification"."streak" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "activity_type" TEXT NOT NULL,
    "current_length" INTEGER NOT NULL DEFAULT 0,
    "longest_length" INTEGER NOT NULL DEFAULT 0,
    "last_activity_date" DATE,
    "freezes_available" SMALLINT NOT NULL DEFAULT 2,
    "freezes_used_total" INTEGER NOT NULL DEFAULT 0,
    "status" "gamification"."streak_status" NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "streak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification"."leaderboard_snapshot" (
    "id" TEXT NOT NULL,
    "scope_type" "gamification"."leaderboard_scope_type" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "points" BIGINT NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification"."processed_events" (
    "source_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("source_event_id","event_type")
);

-- CreateIndex
CREATE INDEX "idx_points_ledger_person" ON "gamification"."points_ledger_entry"("person_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "points_ledger_entry_source_event_type_source_event_id_key" ON "gamification"."points_ledger_entry"("source_event_type", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "badge_slug_key" ON "gamification"."badge"("slug");

-- CreateIndex
CREATE INDEX "idx_badge_award_person" ON "gamification"."badge_award"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "badge_award_person_id_badge_id_key" ON "gamification"."badge_award"("person_id", "badge_id");

-- CreateIndex
CREATE UNIQUE INDEX "streak_person_id_activity_type_key" ON "gamification"."streak"("person_id", "activity_type");

-- CreateIndex
CREATE INDEX "idx_leaderboard_scope_rank" ON "gamification"."leaderboard_snapshot"("scope_type", "scope_id", "period_start", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_snapshot_scope_type_scope_id_person_id_period_s_key" ON "gamification"."leaderboard_snapshot"("scope_type", "scope_id", "person_id", "period_start");

-- AddForeignKey
ALTER TABLE "gamification"."badge_award" ADD CONSTRAINT "badge_award_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "gamification"."badge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generated from schema.prisma — see this migration's schema.prisma header
-- comment (Phase 5 — Gamification section) for why each of these has no
-- Prisma-schema-language equivalent. Same precedent as every other
-- hand-authored addition already in earlier phases' migrations.
-- ---------------------------------------------------------------------------

-- PointsLedgerEntry invariant 1 (docs/ddd/gamification.md): the ledger is
-- append-only — no application code path performs UPDATE or DELETE on this
-- table, enforced defensively here at the database level too, via the
-- exact `CREATE RULE ... DO INSTEAD NOTHING` statements the Schema Sketch
-- itself specifies verbatim. Deliberately a silently-no-op RULE, not a
-- raising trigger (contrast `admin.audit_log`'s insert-only trigger) —
-- matching the Schema Sketch's own literal SQL for this table rather than
-- reusing the audit-log pattern.
CREATE RULE points_ledger_no_update AS ON UPDATE TO "gamification"."points_ledger_entry" DO INSTEAD NOTHING;
CREATE RULE points_ledger_no_delete AS ON DELETE TO "gamification"."points_ledger_entry" DO INSTEAD NOTHING;
