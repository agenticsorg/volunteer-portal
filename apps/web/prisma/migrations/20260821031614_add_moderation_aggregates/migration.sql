-- CreateEnum
CREATE TYPE "moderation"."report_status" AS ENUM ('open', 'reviewing', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "moderation"."scope_type" AS ENUM ('org', 'chapter');

-- CreateEnum
CREATE TYPE "moderation"."action_type" AS ENUM ('warn', 'mute', 'suspend', 'ban');

-- CreateEnum
CREATE TYPE "moderation"."action_status" AS ENUM ('active', 'expired', 'revoked');

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
-- `moderation` schema objects below.

-- AlterTable
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
-- Report invariants (docs/ddd/moderation-trust-safety.md): `scope_id` is
-- required iff `scope_type = 'chapter'`, NULL iff `scope_type = 'org'`
-- (same shape as `community.post`'s scope invariant); at most 6
-- EvidenceAttachment value objects per Report; a Person cannot report
-- themselves (invariant 1).
CREATE TABLE "moderation"."report" (
    "id" TEXT NOT NULL,
    "reporter_person_id" TEXT NOT NULL,
    "reported_entity_type" TEXT NOT NULL,
    "reported_entity_id" TEXT NOT NULL,
    "reported_content_snapshot" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "reason_detail" TEXT,
    "evidence_attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "moderation"."report_status" NOT NULL DEFAULT 'open',
    "scope_type" "moderation"."scope_type" NOT NULL,
    "scope_id" TEXT,
    "assigned_moderator_id" TEXT,
    "resolution_notes" TEXT,
    "resolution_action_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "report_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_report_scope" CHECK (("scope_type" = 'org') = ("scope_id" IS NULL)),
    CONSTRAINT "chk_report_evidence_max" CHECK (jsonb_array_length("evidence_attachments") <= 6),
    CONSTRAINT "chk_report_no_self" CHECK (
        NOT ("reported_entity_type" = 'identity.person' AND "reported_entity_id" = "reporter_person_id")
    )
);

-- CreateTable
-- ModerationAction invariants: `scope_id` is required iff `scope_type =
-- 'chapter'`, NULL iff `scope_type = 'org'`; `warn` and `ban` are never
-- time-boxed (invariant 1); a `ban` is always `org`-scoped regardless of
-- where the underlying report originated (invariant 3).
CREATE TABLE "moderation"."moderation_action" (
    "id" TEXT NOT NULL,
    "action_type" "moderation"."action_type" NOT NULL,
    "target_person_id" TEXT NOT NULL,
    "moderator_person_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "related_report_id" TEXT,
    "scope_type" "moderation"."scope_type" NOT NULL,
    "scope_id" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "status" "moderation"."action_status" NOT NULL DEFAULT 'active',
    "revoked_by_person_id" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_action_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_moderation_action_scope" CHECK (("scope_type" = 'org') = ("scope_id" IS NULL)),
    CONSTRAINT "chk_moderation_action_duration" CHECK ("action_type" NOT IN ('warn', 'ban') OR "ends_at" IS NULL),
    CONSTRAINT "chk_moderation_action_ban_org" CHECK ("action_type" <> 'ban' OR "scope_type" = 'org')
);

-- CreateIndex
CREATE INDEX "idx_report_queue" ON "moderation"."report"("status", "scope_type", "scope_id", "id" DESC);

-- CreateIndex
CREATE INDEX "idx_report_entity" ON "moderation"."report"("reported_entity_type", "reported_entity_id");

-- CreateIndex
CREATE INDEX "idx_report_assigned" ON "moderation"."report"("assigned_moderator_id", "status");

-- CreateIndex
CREATE INDEX "idx_moderation_action_target" ON "moderation"."moderation_action"("target_person_id", "status", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "idx_moderation_action_scope" ON "moderation"."moderation_action"("scope_type", "scope_id", "starts_at" DESC);

-- AddForeignKey
-- Deferred FK (Report -> ModerationAction): Report and ModerationAction
-- reference each other, so this direction can't be a same-statement
-- REFERENCES when both tables are created together — see this migration's
-- own header comment in schema.prisma. Prisma's diff engine already orders
-- this as a post-CREATE-TABLE ALTER, same outcome as the Schema Sketch's
-- own hand-ordered SQL.
ALTER TABLE "moderation"."report" ADD CONSTRAINT "report_resolution_action_id_fkey" FOREIGN KEY ("resolution_action_id") REFERENCES "moderation"."moderation_action"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."moderation_action" ADD CONSTRAINT "moderation_action_related_report_id_fkey" FOREIGN KEY ("related_report_id") REFERENCES "moderation"."report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generates from schema.prisma — see this migration's own header comments
-- in schema.prisma for why this has no Prisma-schema-language equivalent
-- (partial index).
-- ---------------------------------------------------------------------------

-- ExpireModerationActions sweep hot path (docs/ddd/moderation-trust-safety.md
-- Key Use Case 8: the hourly `graphile-worker` job that finds
-- `status = 'active' AND ends_at <= now()` rows). Partial on exactly that
-- predicate shape since expired/revoked actions and indefinite (`ends_at
-- IS NULL`) active actions never match the sweep's query.
CREATE INDEX "idx_moderation_action_expiry"
  ON "moderation"."moderation_action" ("ends_at")
  WHERE "status" = 'active' AND "ends_at" IS NOT NULL;
