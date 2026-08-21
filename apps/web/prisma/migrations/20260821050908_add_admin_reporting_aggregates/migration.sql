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
-- `admin` schema objects below.

-- AlterTable
ALTER TABLE "admin"."audit_log" ALTER COLUMN "ip_address" SET DATA TYPE inet;

-- CreateTable
-- ReportDefinition (docs/ddd/admin-reporting.md): a saved, reusable report
-- configuration. `hourly_valuation_rate_cents` lives on the definition, not
-- as a global config value, so a rate edit here never retroactively changes
-- an already-completed ExportJob's own snapshotted `params` (see below).
CREATE TABLE "admin"."report_definition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "report_type" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "group_by" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "hourly_valuation_rate_cents" INTEGER NOT NULL DEFAULT 3614,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "output_formats" TEXT[] NOT NULL DEFAULT ARRAY['csv', 'pdf']::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_person_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- ExportJob (docs/ddd/admin-reporting.md): one concrete, executed (or
-- in-flight) export — immutable once `completed`/`failed` (invariant 3), a
-- new run is always a new row. `type`/`status`/`output_file_format` are
-- plain TEXT + inline CHECK, not enums, matching the Schema Sketch's own
-- literal DDL and the same convention `notifications.notification.channel`
-- already established (an application-enforced closed set that avoids a
-- migration every time a new job type/status is added). `params` (JSONB)
-- is where invariant 1 actually lives: `hourly_valuation_rate_cents` is
-- copied into this column at request time from the `ReportDefinition`
-- (when set), never re-read live from it at generation time, so a
-- completed grant report's dollar figures never silently change if the
-- definition's rate is edited afterward.
CREATE TABLE "admin"."export_job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "report_definition_id" TEXT,
    "requested_by_person_id" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "identity_dsar_request_id" TEXT,
    "output_file_key" TEXT,
    "output_file_format" TEXT,
    "output_file_expires_at" TIMESTAMPTZ(6),
    "row_count" INTEGER,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_export_job_type" CHECK ("type" IN ('grant_report', 'dsar_export', 'custom')),
    CONSTRAINT "chk_export_job_status" CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
    CONSTRAINT "chk_export_job_output_file_format" CHECK ("output_file_format" IN ('csv', 'pdf', 'zip'))
);

-- CreateIndex
CREATE INDEX "report_definition_active_idx" ON "admin"."report_definition"("is_active", "created_at" DESC);

-- CreateIndex
-- "List pending/running export jobs" — the graphile-worker drain/dispatch
-- query (Schema Sketch). Partial index, no Prisma-schema-language
-- equivalent, hand-authored here per this file's own established
-- precedent for partial indexes.
CREATE INDEX "export_job_active_idx" ON "admin"."export_job"("status", "created_at") WHERE "status" IN ('queued', 'running');

-- CreateIndex
CREATE INDEX "export_job_requested_by_idx" ON "admin"."export_job"("requested_by_person_id", "created_at" DESC);

-- CreateIndex
-- DSAR completion consumer correlation lookup (Schema Sketch). Partial
-- index, same hand-authored precedent as above.
CREATE INDEX "export_job_dsar_request_idx" ON "admin"."export_job"("identity_dsar_request_id") WHERE "identity_dsar_request_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "admin"."export_job" ADD CONSTRAINT "export_job_report_definition_id_fkey" FOREIGN KEY ("report_definition_id") REFERENCES "admin"."report_definition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
