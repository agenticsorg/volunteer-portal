/*
  Warnings:

  - You are about to alter the column `ip_address` on the `audit_log` table. The data in that column could be lost. The data in that column will be cast from `Inet` to `Unsupported("inet")`.

*/
-- CreateEnum
CREATE TYPE "training"."course_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "training"."encode_status" AS ENUM ('uploading', 'processing', 'ready', 'error');

-- CreateEnum
CREATE TYPE "training"."caption_status" AS ENUM ('pending', 'auto_generated', 'human_review', 'approved');

-- CreateEnum
CREATE TYPE "training"."enrollment_status" AS ENUM ('active', 'completed', 'withdrawn');

-- CreateEnum
CREATE TYPE "training"."progress_status" AS ENUM ('not_started', 'in_progress', 'completed');

-- AlterTable
--
-- Prisma's diff engine also proposed, ahead of this comment, a
-- `DROP INDEX "volunteering"."idx_opportunities_search"` and an
-- `ALTER TABLE "volunteering"."opportunities" ALTER COLUMN "search_vector"
-- DROP DEFAULT` — both stripped from this migration. This is the exact
-- known false-diff documented in schema.prisma's `Opportunity` model
-- comment (Prisma's migrate-diff engine cannot fully round-trip the
-- `GENERATED ALWAYS AS ... STORED` column it only sees as
-- `Unsupported("tsvector")`): applying either statement would drop
-- working search infrastructure with no corresponding schema.prisma
-- change to justify it. Declined per that model's own instruction to
-- decline this exact pair every time it resurfaces.
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
CREATE TABLE "training"."course" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "training"."course_status" NOT NULL DEFAULT 'draft',
    "passing_certificate_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_person_id" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector,

    CONSTRAINT "course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."module" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector,

    CONSTRAINT "module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."module_prerequisite" (
    "module_id" TEXT NOT NULL,
    "prerequisite_module_id" TEXT NOT NULL,

    CONSTRAINT "module_prerequisite_pkey" PRIMARY KEY ("module_id","prerequisite_module_id"),
    -- Schema Sketch: CHECK (module_id <> prerequisite_module_id).
    CONSTRAINT "chk_module_prerequisite_no_self_reference" CHECK ("module_id" <> "prerequisite_module_id")
);

-- CreateTable
CREATE TABLE "training"."video" (
    "id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "cloudflare_stream_id" TEXT NOT NULL,
    "duration_seconds" INTEGER,
    "encode_status" "training"."encode_status" NOT NULL DEFAULT 'uploading',
    "caption_status" "training"."caption_status" NOT NULL DEFAULT 'pending',
    "transcript_text" TEXT,
    "thumbnail_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector,

    CONSTRAINT "video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."quiz" (
    "id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "passing_score_percent" SMALLINT NOT NULL,
    "max_attempts" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_pkey" PRIMARY KEY ("id"),
    -- Quiz invariant 4 / Schema Sketch: CHECK (passing_score_percent BETWEEN 1 AND 100).
    CONSTRAINT "chk_quiz_passing_score" CHECK ("passing_score_percent" BETWEEN 1 AND 100)
);

-- CreateTable
CREATE TABLE "training"."quiz_question" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "quiz_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."quiz_choice" (
    "id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "quiz_choice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."enrollment" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "status" "training"."enrollment_status" NOT NULL DEFAULT 'active',
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."module_progress" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "status" "training"."progress_status" NOT NULL DEFAULT 'not_started',
    "resume_position_seconds" INTEGER NOT NULL DEFAULT 0,
    "watch_progress_percent" SMALLINT NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "module_progress_pkey" PRIMARY KEY ("id"),
    -- Watch Progress definition / Schema Sketch: CHECK (watch_progress_percent BETWEEN 0 AND 100).
    CONSTRAINT "chk_module_progress_watch_percent" CHECK ("watch_progress_percent" BETWEEN 0 AND 100)
);

-- CreateTable
CREATE TABLE "training"."quiz_attempt" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "score_percent" SMALLINT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_attempt_pkey" PRIMARY KEY ("id"),
    -- Schema Sketch: CHECK (score_percent BETWEEN 0 AND 100).
    CONSTRAINT "chk_quiz_attempt_score_percent" CHECK ("score_percent" BETWEEN 0 AND 100)
);

-- CreateTable
CREATE TABLE "training"."quiz_attempt_answer" (
    "attempt_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "choice_id" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL,

    CONSTRAINT "quiz_attempt_answer_pkey" PRIMARY KEY ("attempt_id","question_id")
);

-- CreateTable
CREATE TABLE "training"."certificate" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "certificate_number" TEXT NOT NULL,
    "pdf_file_key" TEXT,
    "template_version" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "certificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "course_slug_key" ON "training"."course"("slug");

-- CreateIndex
CREATE INDEX "idx_course_status" ON "training"."course"("status");

-- CreateIndex
CREATE INDEX "idx_module_course" ON "training"."module"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_course_id_sequence_key" ON "training"."module"("course_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "video_module_id_key" ON "training"."video"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_cloudflare_stream_id_key" ON "training"."video"("cloudflare_stream_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_module_id_key" ON "training"."quiz"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_question_quiz_id_sequence_key" ON "training"."quiz_question"("quiz_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_choice_question_id_sequence_key" ON "training"."quiz_choice"("question_id", "sequence");

-- CreateIndex
CREATE INDEX "idx_enrollment_person" ON "training"."enrollment"("person_id");

-- CreateIndex
CREATE INDEX "idx_module_progress_enrollment" ON "training"."module_progress"("enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_progress_enrollment_id_module_id_key" ON "training"."module_progress"("enrollment_id", "module_id");

-- CreateIndex
CREATE INDEX "idx_quiz_attempt_enrollment_quiz" ON "training"."quiz_attempt"("enrollment_id", "quiz_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_certificate_number_key" ON "training"."certificate"("certificate_number");

-- CreateIndex
CREATE INDEX "idx_certificate_person" ON "training"."certificate"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_person_id_course_id_enrollment_id_key" ON "training"."certificate"("person_id", "course_id", "enrollment_id");

-- AddForeignKey
ALTER TABLE "training"."module" ADD CONSTRAINT "module_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "training"."course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."module_prerequisite" ADD CONSTRAINT "module_prerequisite_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "training"."module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."module_prerequisite" ADD CONSTRAINT "module_prerequisite_prerequisite_module_id_fkey" FOREIGN KEY ("prerequisite_module_id") REFERENCES "training"."module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."video" ADD CONSTRAINT "video_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "training"."module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz" ADD CONSTRAINT "quiz_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "training"."module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_question" ADD CONSTRAINT "quiz_question_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "training"."quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_choice" ADD CONSTRAINT "quiz_choice_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "training"."quiz_question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."enrollment" ADD CONSTRAINT "enrollment_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "training"."course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."module_progress" ADD CONSTRAINT "module_progress_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "training"."enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."module_progress" ADD CONSTRAINT "module_progress_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "training"."module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_attempt" ADD CONSTRAINT "quiz_attempt_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "training"."enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_attempt" ADD CONSTRAINT "quiz_attempt_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "training"."quiz"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_attempt_answer" ADD CONSTRAINT "quiz_attempt_answer_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "training"."quiz_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_attempt_answer" ADD CONSTRAINT "quiz_attempt_answer_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "training"."quiz_question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."quiz_attempt_answer" ADD CONSTRAINT "quiz_attempt_answer_choice_id_fkey" FOREIGN KEY ("choice_id") REFERENCES "training"."quiz_choice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."certificate" ADD CONSTRAINT "certificate_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "training"."course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training"."certificate" ADD CONSTRAINT "certificate_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "training"."enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generates from schema.prisma — see this migration's own header comments
-- in schema.prisma for why each of these has no Prisma-schema-language
-- equivalent (partial indexes, generated columns). Same precedent as the
-- Phase 3 volunteering migration's own hand-authored section.
-- ---------------------------------------------------------------------------

-- Enrollment invariant 1 (docs/ddd/training-learning.md): exactly one
-- **active** Enrollment per (personId, courseId) — a partial unique index,
-- which Prisma's schema language cannot express. Re-enrollment after
-- `withdrawn`/`completed` is allowed (those rows fall outside the WHERE
-- clause and never collide), matching the Schema Sketch's own comment.
CREATE UNIQUE INDEX "uq_enrollment_active_person_course"
  ON "training"."enrollment" ("person_id", "course_id")
  WHERE "status" = 'active';

-- ADR-0017: Postgres full-text search, split across the three tables that
-- actually own searchable text in this schema (see this migration's
-- header comment in schema.prisma for why three columns, not one, unlike
-- `volunteering.opportunities.search_vector`). Each `search_vector` was
-- created above as a plain nullable `tsvector` column (the shape Prisma's
-- `Unsupported("tsvector")` produces); each is converted here into the
-- real `GENERATED ALWAYS AS ... STORED` column so it stays automatically
-- in sync with its source column(s) on every insert/update, with no
-- separate trigger or application-level reindex step — same pattern as
-- `volunteering.opportunities.search_vector`.

-- Course: title (weight A) ranks above description (weight C), same
-- title-over-body-text convention as `volunteering.opportunities`.
ALTER TABLE "training"."course" DROP COLUMN "search_vector";
ALTER TABLE "training"."course" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;

CREATE INDEX "idx_course_search" ON "training"."course" USING GIN ("search_vector");

-- Module: only searchable field is `title` (no `description` on this
-- entity per the Schema Sketch), so no weighting is needed — same
-- single-field pattern as `community.posts.search_vector` in ADR-0017's
-- own worked example.
ALTER TABLE "training"."module" DROP COLUMN "search_vector";
ALTER TABLE "training"."module" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("title", ''))
  ) STORED;

CREATE INDEX "idx_module_search" ON "training"."module" USING GIN ("search_vector");

-- Video: only searchable field is `transcript_text` (populated once a
-- human reviewer approves captions — ADR-0010/ADR-0014), same
-- single-field pattern as above. This is the literal `idx_video_transcript_fts`
-- functional index from the Schema Sketch, upgraded to the
-- generated-column + GIN pattern used consistently across this migration.
ALTER TABLE "training"."video" DROP COLUMN "search_vector";
ALTER TABLE "training"."video" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("transcript_text", ''))
  ) STORED;

CREATE INDEX "idx_video_search" ON "training"."video" USING GIN ("search_vector");
