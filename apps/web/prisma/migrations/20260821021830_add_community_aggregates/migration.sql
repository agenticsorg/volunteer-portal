/*
  Warnings:

  - You are about to alter the column `ip_address` on the `audit_log` table. The data in that column could be lost. The data in that column will be cast from `Inet` to `Unsupported("inet")`.

*/
-- CreateEnum
CREATE TYPE "community"."scope_type" AS ENUM ('org', 'chapter');

-- CreateEnum
CREATE TYPE "community"."post_status" AS ENUM ('published', 'hidden', 'deleted');

-- CreateEnum
CREATE TYPE "community"."feed_entry_kind" AS ENUM ('post', 'kudos_given', 'team_joined', 'mentorship_started', 'mentorship_completed', 'badge_awarded', 'hours_approved', 'course_completed', 'streak_extended');

-- CreateEnum
CREATE TYPE "community"."team_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "community"."team_role" AS ENUM ('lead', 'member');

-- CreateEnum
CREATE TYPE "community"."mentorship_status" AS ENUM ('requested', 'active', 'completed', 'declined', 'cancelled');

-- Prisma's diff engine, run against this schema from this point on, always
-- misreads every prior phase's `GENERATED ALWAYS AS ... STORED` tsvector
-- columns (`training.course/module/video.search_vector`,
-- `volunteering.opportunities.search_vector`) as plain columns with a
-- default, and proposes dropping their default and their GIN index every
-- time — the exact same spurious diff already reproduced and declined once
-- per each of those migrations' own header comments in schema.prisma. The
-- generator emitted six such statements here (three `DROP INDEX`, four
-- `ALTER COLUMN ... DROP DEFAULT`, one overlapping) against `training` and
-- `volunteering` tables this migration has no other business touching;
-- deliberately removed from this hand-edited file — never applied, per that
-- same precedent — leaving only this migration's actual job: the `admin`
-- cast (also just a repeat of every prior migration's boilerplate) and the
-- new `community` schema objects below.

-- AlterTable
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
-- `search_vector` is created here as a plain nullable column (what
-- `prisma migrate dev --create-only` generates for an
-- `Unsupported("tsvector")` field) and immediately replaced below with the
-- real ADR-0017 `GENERATED ALWAYS AS ... STORED` column — same two-step
-- (create nullable, then `ALTER COLUMN ... ADD GENERATED`) hand-authored
-- precedent as `volunteering.opportunities.search_vector` and
-- `training.course/module/video.search_vector`, per ADR-0017's own
-- Implementation Notes.
CREATE TABLE "community"."post" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_display_name" TEXT NOT NULL,
    "author_chapter_id" TEXT,
    "body" TEXT NOT NULL,
    "scope_type" "community"."scope_type" NOT NULL,
    "scope_id" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "community"."post_status" NOT NULL DEFAULT 'published',
    "hidden_by_moderation_action_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector,

    CONSTRAINT "post_pkey" PRIMARY KEY ("id"),
    -- Post invariant / Schema Sketch: `scope_id` is required iff
    -- `scope_type = 'chapter'`, NULL iff `scope_type = 'org'`.
    CONSTRAINT "chk_post_scope" CHECK (("scope_type" = 'org') = ("scope_id" IS NULL)),
    -- Post: `body` is plain text/limited markdown, 1-5000 chars.
    CONSTRAINT "chk_post_body_length" CHECK (char_length("body") BETWEEN 1 AND 5000),
    -- Post: 0-4 Attachment value objects per Post.
    CONSTRAINT "chk_post_attachments_max" CHECK (jsonb_array_length("attachments") <= 4)
);

-- CreateTable
CREATE TABLE "community"."feed_entry" (
    "id" TEXT NOT NULL,
    "kind" "community"."feed_entry_kind" NOT NULL,
    "scope_type" "community"."scope_type" NOT NULL,
    "scope_id" TEXT,
    "subject_person_id" TEXT NOT NULL,
    "subject_display_name" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_event_id" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "hidden_at" TIMESTAMPTZ(6),
    "hidden_by_moderation_action_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_entry_pkey" PRIMARY KEY ("id"),
    -- FeedEntry: `scope_id` is required iff `scope_type = 'chapter'`, NULL
    -- iff `scope_type = 'org'` — same shape as Post's scope invariant.
    CONSTRAINT "chk_feed_entry_scope" CHECK (("scope_type" = 'org') = ("scope_id" IS NULL))
);

-- CreateTable
CREATE TABLE "community"."kudos" (
    "id" TEXT NOT NULL,
    "from_person_id" TEXT NOT NULL,
    "to_person_id" TEXT NOT NULL,
    "note" TEXT,
    "achievement_ref_type" TEXT,
    "achievement_ref_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kudos_pkey" PRIMARY KEY ("id"),
    -- Kudos invariant 1: no self-kudos.
    CONSTRAINT "chk_kudos_no_self" CHECK ("from_person_id" <> "to_person_id"),
    -- Kudos invariant 2: the achievement reference is all-or-nothing.
    CONSTRAINT "chk_kudos_achievement_ref_pair" CHECK (
        ("achievement_ref_type" IS NULL) = ("achievement_ref_id" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "community"."team" (
    "id" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_by_person_id" TEXT NOT NULL,
    "status" "community"."team_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community"."team_membership" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role" "community"."team_role" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),

    CONSTRAINT "team_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community"."mentorship" (
    "id" TEXT NOT NULL,
    "mentor_person_id" TEXT NOT NULL,
    "mentee_person_id" TEXT NOT NULL,
    "status" "community"."mentorship_status" NOT NULL DEFAULT 'requested',
    "note" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "mentorship_pkey" PRIMARY KEY ("id"),
    -- Mentorship invariant 1: mentor and mentee must be different people.
    CONSTRAINT "chk_mentorship_no_self" CHECK ("mentor_person_id" <> "mentee_person_id")
);

-- CreateTable
CREATE TABLE "community"."processed_events" (
    "id" TEXT NOT NULL,
    "source_context" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_post_scope_created" ON "community"."post"("scope_type", "scope_id", "id" DESC);

-- CreateIndex
CREATE INDEX "idx_post_author" ON "community"."post"("author_id");

-- CreateIndex
CREATE INDEX "idx_kudos_to_person" ON "community"."kudos"("to_person_id", "id" DESC);

-- CreateIndex
CREATE INDEX "idx_kudos_from_person" ON "community"."kudos"("from_person_id", "id" DESC);

-- CreateIndex
CREATE INDEX "idx_mentorship_mentor" ON "community"."mentorship"("mentor_person_id", "status");

-- AddForeignKey
ALTER TABLE "community"."team_membership" ADD CONSTRAINT "team_membership_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "community"."team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generates from schema.prisma — see this migration's own header comments
-- in schema.prisma for why each of these has no Prisma-schema-language
-- equivalent (partial indexes/uniques and the generated tsvector column).
-- ---------------------------------------------------------------------------

-- FeedEntry: the chapter-scoped, reverse-chronological feed hot path
-- (docs/ddd/community-social.md Schema Sketch's own worked query:
-- `WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2 AND
-- hidden_at IS NULL ORDER BY id DESC`). Partial on `hidden_at IS NULL`
-- since hidden entries never appear in a live feed query.
CREATE INDEX "idx_feed_entry_scope_created"
  ON "community"."feed_entry" ("scope_type", "scope_id", "id" DESC)
  WHERE "hidden_at" IS NULL;

-- FeedEntry invariant 3: exactly one FeedEntry per (source_type, source_id)
-- for native kinds (source_event_id IS NULL — i.e. kind = 'post', whose
-- source is community.post itself) ...
CREATE UNIQUE INDEX "uq_feed_entry_native_source"
  ON "community"."feed_entry" ("source_type", "source_id")
  WHERE "source_event_id" IS NULL;

-- ... and exactly one FeedEntry per source_event_id for projected kinds
-- (badge_awarded/hours_approved/course_completed/streak_extended) — the two
-- indexes are mutually exclusive by construction (exactly one of
-- `source_event_id IS NULL` holds for any row), making re-processing an
-- at-least-once-delivered event a no-op rather than a duplicate feed row,
-- as a second line of defense behind `community.processed_events`.
CREATE UNIQUE INDEX "uq_feed_entry_source_event"
  ON "community"."feed_entry" ("source_event_id")
  WHERE "source_event_id" IS NOT NULL;

-- Team invariant 1: (chapterId, name) is unique among `active` Teams only —
-- an archived Team's name may be reused by a new active Team in the same
-- Chapter.
CREATE UNIQUE INDEX "uq_team_chapter_name_active"
  ON "community"."team" ("chapter_id", "name")
  WHERE "status" = 'active';

-- TeamMembership invariant 2: a Person has at most one *open* membership
-- (leftAt IS NULL) per Team — re-joining after leaving creates a new row,
-- which falls outside this partial index's WHERE clause and never
-- collides.
CREATE UNIQUE INDEX "uq_team_membership_open"
  ON "community"."team_membership" ("team_id", "person_id")
  WHERE "left_at" IS NULL;

-- Lookup path: a Person's currently-open team memberships (e.g. "which
-- teams am I on right now").
CREATE INDEX "idx_team_membership_person"
  ON "community"."team_membership" ("person_id")
  WHERE "left_at" IS NULL;

-- Mentorship invariant 2: a Person may have at most one `requested` or
-- `active` Mentorship as mentee at a time — no equivalent constraint on
-- mentor_person_id (a mentor may have several concurrent mentees).
CREATE UNIQUE INDEX "uq_mentorship_open_mentee"
  ON "community"."mentorship" ("mentee_person_id")
  WHERE "status" IN ('requested', 'active');

-- ADR-0017: Postgres full-text search. `search_vector` was created above as
-- a plain nullable `tsvector` column (the shape Prisma's
-- `Unsupported("tsvector")` produces); it is converted here into the real
-- `GENERATED ALWAYS AS ... STORED` column so it stays automatically in sync
-- with `body` on every insert/update, with no separate trigger or
-- application-level reindex step. Single-field pattern (`body` only),
-- matching ADR-0017's own `community.posts` worked example exactly — unlike
-- `volunteering.opportunities`/`training.course`, this aggregate has no
-- separate title/category fields to weight above the body text.
ALTER TABLE "community"."post" DROP COLUMN "search_vector";
ALTER TABLE "community"."post" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("body", ''))
  ) STORED;

CREATE INDEX "idx_post_search" ON "community"."post" USING GIN ("search_vector");
