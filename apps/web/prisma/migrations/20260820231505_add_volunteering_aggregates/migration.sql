/*
  Warnings:

  - You are about to alter the column `ip_address` on the `audit_log` table. The data in that column could be lost. The data in that column will be cast from `Inet` to `Unsupported("inet")`.

*/
-- CreateEnum
CREATE TYPE "volunteering"."opportunity_status" AS ENUM ('draft', 'published', 'closed', 'archived');

-- CreateEnum
CREATE TYPE "volunteering"."location_type" AS ENUM ('in_person', 'remote', 'hybrid');

-- CreateEnum
CREATE TYPE "volunteering"."shift_status" AS ENUM ('scheduled', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "volunteering"."application_status" AS ENUM ('pending', 'accepted', 'waitlisted', 'declined', 'withdrawn');

-- CreateEnum
CREATE TYPE "volunteering"."hour_entry_status" AS ENUM ('submitted', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
-- `search_vector` is created here as a plain nullable column (what
-- `prisma migrate dev --create-only` generates for an
-- `Unsupported("tsvector")` field) and immediately replaced below with the
-- real ADR-0017 `GENERATED ALWAYS AS ... STORED` column — Postgres does not
-- allow `GENERATED ALWAYS AS` inline alongside other column definitions in
-- a way Prisma's diff engine can express, so the two-step (create nullable,
-- then `ALTER COLUMN ... ADD GENERATED`) is hand-authored here, per
-- ADR-0017's own Implementation Notes.
CREATE TABLE "volunteering"."opportunities" (
    "id" TEXT NOT NULL,
    "chapter_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "skills_required" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "location_type" "volunteering"."location_type" NOT NULL,
    "min_age" INTEGER NOT NULL DEFAULT 16,
    "prerequisite_course_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_person_id" TEXT NOT NULL,
    "status" "volunteering"."opportunity_status" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id"),
    -- Opportunity invariant / Schema Sketch: `publish` requires non-empty
    -- `title` and `description`; `draft` rows may still have either blank
    -- while being authored.
    CONSTRAINT "chk_opportunities_publish" CHECK (
        "status" = 'draft' OR ("title" <> '' AND "description" <> '')
    )
);

-- CreateTable
CREATE TABLE "volunteering"."shifts" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "status" "volunteering"."shift_status" NOT NULL DEFAULT 'scheduled',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_shifts_capacity_min" CHECK ("capacity" >= 1),
    CONSTRAINT "chk_shifts_accepted_count_min" CHECK ("accepted_count" >= 0),
    CONSTRAINT "chk_shifts_time_order" CHECK ("ends_at" > "starts_at"),
    -- Shift invariant 3: `accepted_count` must never exceed `capacity` —
    -- updated transactionally alongside `Application` accept/decline/
    -- withdraw transitions at the application layer; this CHECK is the
    -- database-level backstop.
    CONSTRAINT "chk_shifts_capacity" CHECK ("accepted_count" <= "capacity")
);

-- CreateTable
CREATE TABLE "volunteering"."applications" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "applicant_person_id" TEXT NOT NULL,
    "status" "volunteering"."application_status" NOT NULL DEFAULT 'pending',
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_person_id" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteering"."hour_entries" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "shift_id" TEXT,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "description" TEXT,
    "status" "volunteering"."hour_entry_status" NOT NULL DEFAULT 'submitted',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approver_person_id" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,

    CONSTRAINT "hour_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_hour_entries_time_order" CHECK ("end_at" > "start_at"),
    CONSTRAINT "chk_hour_entries_duration" CHECK ("duration_minutes" > 0 AND "duration_minutes" <= 1440),
    -- HourEntry invariant 2/3: `approver_person_id`/`approved_at` are
    -- required exactly when `approved`, `approver_person_id`/`rejected_at`/
    -- `rejection_reason` are required exactly when `rejected`, and no
    -- approver is set while still `submitted`.
    CONSTRAINT "chk_hour_entries_approval" CHECK (
        ("status" = 'approved' AND "approver_person_id" IS NOT NULL AND "approved_at" IS NOT NULL)
        OR ("status" = 'rejected' AND "approver_person_id" IS NOT NULL AND "rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL)
        OR ("status" = 'submitted' AND "approver_person_id" IS NULL)
    ),
    -- HourEntry invariant 2: no self-approval.
    CONSTRAINT "chk_hour_entries_no_self_approval" CHECK (
        "approver_person_id" IS NULL OR "approver_person_id" <> "person_id"
    )
);

-- CreateIndex
CREATE INDEX "idx_opportunities_chapter" ON "volunteering"."opportunities"("chapter_id");

-- CreateIndex
CREATE INDEX "idx_opportunities_status" ON "volunteering"."opportunities"("status");

-- CreateIndex
CREATE INDEX "idx_shifts_opportunity" ON "volunteering"."shifts"("opportunity_id");

-- CreateIndex
CREATE INDEX "idx_shifts_starts_at" ON "volunteering"."shifts"("starts_at");

-- CreateIndex
CREATE INDEX "idx_applications_shift" ON "volunteering"."applications"("shift_id");

-- CreateIndex
CREATE INDEX "idx_applications_applicant" ON "volunteering"."applications"("applicant_person_id");

-- CreateIndex
CREATE INDEX "idx_hour_entries_person" ON "volunteering"."hour_entries"("person_id");

-- CreateIndex
CREATE INDEX "idx_hour_entries_opportunity" ON "volunteering"."hour_entries"("opportunity_id");

-- AddForeignKey
ALTER TABLE "volunteering"."shifts" ADD CONSTRAINT "shifts_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "volunteering"."opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteering"."applications" ADD CONSTRAINT "applications_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "volunteering"."shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteering"."hour_entries" ADD CONSTRAINT "hour_entries_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "volunteering"."opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteering"."hour_entries" ADD CONSTRAINT "hour_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "volunteering"."shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generates from schema.prisma — see this migration's own header comments
-- in schema.prisma for why each of these has no Prisma-schema-language
-- equivalent (partial indexes, CHECK-with-subquery-adjacent boolean logic
-- already handled above, generated columns, and triggers).
-- ---------------------------------------------------------------------------

-- Application invariant 1 (docs/ddd/volunteering-opportunities.md): at most
-- one non-terminal-or-accepted Application per (applicant, shift) — a
-- partial unique index, which Prisma's schema language cannot express.
-- Re-applying after `declined`/`withdrawn` is allowed (those rows fall
-- outside the WHERE clause and never collide).
CREATE UNIQUE INDEX "uq_applications_active_per_shift"
  ON "volunteering"."applications" ("applicant_person_id", "shift_id")
  WHERE "status" IN ('pending', 'accepted', 'waitlisted');

-- Grant-export hot path (Schema Sketch): approved hours by date range.
-- Partial on `status = 'approved'` since that's the only status
-- `queryApprovedHours`/`exportApproved` ever filters on.
CREATE INDEX "idx_hour_entries_approved_export"
  ON "volunteering"."hour_entries" ("approved_at")
  WHERE "status" = 'approved';

-- ADR-0017: Postgres full-text search. `search_vector` was created above as
-- a plain nullable `tsvector` column (the shape Prisma's
-- `Unsupported("tsvector")` produces); it is converted here into the real
-- `GENERATED ALWAYS AS ... STORED` column so it stays automatically in
-- sync with `title`/`category`/`skills_required`/`description` on every
-- insert/update, with no separate trigger or application-level reindex
-- step. Weighted A (title) > B (category, skills) > C (description) so
-- title matches rank above body-text matches (`ts_rank`), matching
-- ADR-0017's own worked example. `skills_required` is a `text[]`, not a
-- second denormalized text column the way ADR-0017's illustrative example
-- assumes for `skills_tags_text` — generated columns may only reference
-- other columns on the same row, so it's flattened in-expression instead.
--
-- Postgres's built-in `array_to_string(anyarray, text)` is STABLE, not
-- IMMUTABLE (confirmed directly: `select provolatile from pg_proc where
-- proname = 'array_to_string'` returns `s`), and `GENERATED ALWAYS AS`
-- expressions require every function in the expression tree to be
-- IMMUTABLE — using it inline fails with "generation expression is not
-- immutable" (reproduced directly). The standard, well-known fix (and the
-- one used here) is a thin `IMMUTABLE` SQL wrapper: array-to-string
-- concatenation with a fixed separator has no dependency on session state,
-- locale, or table data, so asserting immutability is safe.
CREATE FUNCTION "volunteering".immutable_array_to_string(text[], text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT array_to_string($1, $2);
$$;

ALTER TABLE "volunteering"."opportunities" DROP COLUMN "search_vector";
ALTER TABLE "volunteering"."opportunities" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("category", '') || ' ' || "volunteering".immutable_array_to_string("skills_required", ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;

CREATE INDEX "idx_opportunities_search" ON "volunteering"."opportunities" USING GIN ("search_vector");

-- ADR-0014 / HourEntry invariant 3: once `status = 'approved'`, the row is
-- immutable — no field may be updated thereafter. Enforced at the
-- application/repository layer (not built in this phase) and, as
-- defense-in-depth, by this database trigger — same "trigger as real
-- backstop" precedent as `admin.audit_log`'s insert-only trigger and
-- `identity.persons`'s age-gate trigger. A correction to an approved entry
-- requires a new, separate HourEntry row; this trigger blocks any UPDATE
-- (including e.g. a well-intentioned status re-transition) once the OLD row
-- is already `approved`, unconditionally.
CREATE FUNCTION "volunteering".prevent_approved_hour_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'volunteering.hour_entries row % is approved and immutable', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_hour_entries_immutable"
  BEFORE UPDATE ON "volunteering"."hour_entries"
  FOR EACH ROW EXECUTE FUNCTION "volunteering".prevent_approved_hour_entry_mutation();
