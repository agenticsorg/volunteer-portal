/*
  Warnings:

  - You are about to alter the column `ip_address` on the `audit_log` table. The data in that column could be lost. The data in that column will be cast from `Inet` to `Unsupported("inet")`.

*/
-- This is the same no-op-in-practice ALTER the Phase 1 migration's own
-- header comment documents (see AuditLog's model comment in schema.prisma):
-- Prisma's migration-diff engine cannot fully round-trip an
-- `Unsupported("inet")` native type, so every future `migrate dev`/`migrate
-- diff` proposes this same-type, no-data-loss `ALTER COLUMN ... SET DATA
-- TYPE inet` against `admin.audit_log`. Confirmed safe to accept here for
-- the same reason as before.

-- citext is required by `identity.persons.email` and
-- `identity.consent_records.guardian_email` below (Schema Sketch,
-- docs/ddd/identity-access-schema-api.md). Not declared via Prisma's
-- `postgresqlExtensions` preview feature (schema.prisma is intentionally
-- kept on GA multi-schema mode only, per its own header comment), so this
-- extension statement has no `datasource` counterpart and is hand-authored
-- here — same precedent as the Phase 0 baseline migration's hand-authored
-- `CREATE SCHEMA` statements.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "identity"."role_name" AS ENUM ('volunteer', 'mentor', 'chapter_lead', 'content_admin', 'org_admin', 'moderator');

-- CreateEnum
CREATE TYPE "identity"."scope_type" AS ENUM ('global', 'chapter', 'team');

-- CreateEnum
CREATE TYPE "identity"."consent_purpose" AS ENUM ('terms_of_service', 'newsletter', 'photo_publication', 'leaderboard_participation', 'analytics_cookies', 'guardian_consent');

-- CreateEnum
CREATE TYPE "identity"."dsar_type" AS ENUM ('export', 'erasure');

-- CreateEnum
CREATE TYPE "identity"."dsar_status" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- AlterTable
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
CREATE TABLE "identity"."chapters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "country" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "founded_at" DATE,
    "lead_person_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."persons" (
    "id" TEXT NOT NULL,
    "public_slug" TEXT NOT NULL,
    "supabase_auth_id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "pronouns" TEXT,
    "avatar_url" TEXT,
    "bio" TEXT,
    "date_of_birth" DATE,
    "age_attested_16_plus" BOOLEAN NOT NULL DEFAULT false,
    "primary_chapter_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "anonymized_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role_assignments" (
    "id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "role" "identity"."role_name" NOT NULL,
    "scope_type" "identity"."scope_type" NOT NULL DEFAULT 'global',
    "scope_id" TEXT,
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."consent_records" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "purpose" "identity"."consent_purpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "policy_version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "guardian_name" TEXT,
    "guardian_email" CITEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."dsar_requests" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "type" "identity"."dsar_type" NOT NULL,
    "status" "identity"."dsar_status" NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "export_file_url" TEXT,
    "failure_reason" TEXT,

    CONSTRAINT "dsar_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chapters_slug_key" ON "identity"."chapters"("slug");

-- CreateIndex
CREATE INDEX "idx_chapters_status" ON "identity"."chapters"("status");

-- CreateIndex
CREATE UNIQUE INDEX "persons_public_slug_key" ON "identity"."persons"("public_slug");

-- CreateIndex
CREATE UNIQUE INDEX "persons_supabase_auth_id_key" ON "identity"."persons"("supabase_auth_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_email_key" ON "identity"."persons"("email");

-- CreateIndex
CREATE INDEX "idx_persons_chapter" ON "identity"."persons"("primary_chapter_id");

-- CreateIndex
CREATE INDEX "idx_persons_status" ON "identity"."persons"("status");

-- CreateIndex
CREATE INDEX "idx_consent_records_person_purpose" ON "identity"."consent_records"("person_id", "purpose", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_dsar_requests_person" ON "identity"."dsar_requests"("person_id");

-- AddForeignKey
ALTER TABLE "identity"."persons" ADD CONSTRAINT "persons_primary_chapter_id_fkey" FOREIGN KEY ("primary_chapter_id") REFERENCES "identity"."chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "identity"."persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "identity"."persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "identity"."persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."consent_records" ADD CONSTRAINT "consent_records_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "identity"."persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."dsar_requests" ADD CONSTRAINT "dsar_requests_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "identity"."persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."dsar_requests" ADD CONSTRAINT "dsar_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "identity"."persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generated from schema.prisma (same precedent as the Phase 0 baseline and
-- Phase 1 event-backbone migrations: CHECK constraints have no
-- Prisma-schema-language equivalent in this Prisma version, and Prisma's
-- schema language has no partial-index syntax — both are added directly
-- here, exactly matching the Schema Sketch in
-- docs/ddd/identity-access-schema-api.md).
-- ---------------------------------------------------------------------------

-- Unnamed inline CHECKs from the sketch (Postgres auto-names these
-- `<table>_<column>_check`, reproduced as `ADD CHECK` with no explicit
-- constraint name to match).
ALTER TABLE "identity"."chapters" ADD CHECK ("status" IN ('active', 'inactive'));

ALTER TABLE "identity"."persons" ADD CHECK ("status" IN ('active', 'deactivated', 'anonymized'));

ALTER TABLE "identity"."consent_records" ADD CHECK ("source" IN ('signup_form', 'settings_page', 'guardian_form', 'admin_override'));

-- Named CHECKs from the sketch.

-- Age gate (docs/ddd/identity-access.md Person invariant 2): a defense-in-
-- depth DB backstop for the `RegisterPerson` use case's own age-gate logic
-- (not built until a later phase) — a Person must have either a DOB, an
-- explicit 16+ attestation, or already be anonymized (whose DOB has been
-- scrubbed).
ALTER TABLE "identity"."persons" ADD CONSTRAINT "chk_persons_age_gate" CHECK (
  "status" = 'anonymized'
  OR "date_of_birth" IS NOT NULL
  OR "age_attested_16_plus" = true
);

-- Anonymized-status invariant: `anonymized_at` is set if and only if
-- `status = 'anonymized'` — keeps the terminal `AnonymizePerson` transition
-- (Person invariant 3) internally consistent even against a direct SQL
-- write that bypasses the application layer.
ALTER TABLE "identity"."persons" ADD CONSTRAINT "chk_persons_anonymized_at" CHECK (
  ("status" = 'anonymized' AND "anonymized_at" IS NOT NULL)
  OR ("status" <> 'anonymized' AND "anonymized_at" IS NULL)
);

-- RoleAssignment invariant 1: `scope_type = 'global'` iff `scope_id IS
-- NULL`; `scope_type IN ('chapter', 'team')` iff `scope_id IS NOT NULL`.
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "chk_role_assignments_scope" CHECK (
  ("scope_type" = 'global' AND "scope_id" IS NULL)
  OR ("scope_type" IN ('chapter', 'team') AND "scope_id" IS NOT NULL)
);

-- Revocation is all-or-nothing: `revoked_by`/`revoked_at` are either both
-- null (still active) or both set (revoked) — never one without the other.
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "chk_role_assignments_revocation" CHECK (
  ("revoked_at" IS NULL AND "revoked_by" IS NULL)
  OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
);

-- ConsentRecord invariant 1: guardian_consent purpose requires both
-- guardian fields to be populated.
ALTER TABLE "identity"."consent_records" ADD CONSTRAINT "chk_consent_guardian_fields" CHECK (
  "purpose" <> 'guardian_consent'
  OR ("guardian_name" IS NOT NULL AND "guardian_email" IS NOT NULL)
);

-- Partial indexes (no Prisma `@@index` counterpart — Prisma's schema
-- language has no `WHERE` clause for indexes).

-- RoleAssignment invariant 2: exactly one active assignment may exist per
-- (subject, role, scope) tuple at a time. Enforced at the DB layer via a
-- partial unique index scoped to `revoked_at IS NULL`, so a revoked-then-
-- regranted history for the same tuple is allowed but two simultaneously
-- active grants are not.
CREATE UNIQUE INDEX "uq_role_assignments_active"
  ON "identity"."role_assignments" ("subject_id", "role", "scope_type", "scope_id")
  WHERE "revoked_at" IS NULL;

-- Cheap "this subject's active roles" lookup — the `can()` policy module's
-- hot path (ADR-0007).
CREATE INDEX "idx_role_assignments_subject_active"
  ON "identity"."role_assignments" ("subject_id")
  WHERE "revoked_at" IS NULL;

-- DSARRequest invariant 3: at most one open (pending/processing) request
-- per (person, type) at a time. This partial index makes that open-request
-- lookup cheap; the uniqueness itself is enforced at the application layer
-- (Key Use Cases 6 & 7's Pre-conditions), not by a DB constraint, since the
-- "open" set spans two status values rather than a single fixed one a
-- partial unique index could target directly.
CREATE INDEX "idx_dsar_requests_open"
  ON "identity"."dsar_requests" ("person_id", "type")
  WHERE "status" IN ('pending', 'processing');
