-- CreateTable
CREATE TABLE "identity"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteering"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."domain_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."audit_log" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "scope_type" TEXT,
    "scope_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" inet,
    "request_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_actor_idx" ON "admin"."audit_log"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_resource_idx" ON "admin"."audit_log"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "admin"."audit_log"("action", "occurred_at" DESC);

-- ---------------------------------------------------------------------------
-- Hand-authored additions beyond what `prisma migrate dev --create-only`
-- generated from schema.prisma (same precedent as the Phase 0 baseline
-- migration's hand-authored `CREATE SCHEMA` statements: this SQL has no
-- corresponding Prisma-schema-language construct, so it is added directly
-- here and intentionally not represented as a schema.prisma attribute).
-- ---------------------------------------------------------------------------

-- Partial "undispatched/unprocessed" indexes (ADR-0009's own outbox-table
-- sketch: "CREATE INDEX ... ON training.domain_events (id) WHERE
-- dispatched_at IS NULL"), one per schema's domain_events table, so the
-- audit_log_writer drain worker's `WHERE processed_at IS NULL` scan stays
-- cheap as each table grows instead of degrading to a full scan.
CREATE INDEX "domain_events_unprocessed_idx" ON "identity"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "volunteering"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "training"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "gamification"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "community"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "moderation"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "notifications"."domain_events" ("id") WHERE "processed_at" IS NULL;
CREATE INDEX "domain_events_unprocessed_idx" ON "admin"."domain_events" ("id") WHERE "processed_at" IS NULL;

-- ---------------------------------------------------------------------------
-- admin.audit_log is insert-only (ADR-0014 §4: "the app's Postgres role has
-- no UPDATE/DELETE grant on admin.audit_log; corrections are new rows,
-- never edits"). Enforced with TWO defense-in-depth layers, deliberately,
-- because a plain REVOKE is not sufficient in every environment this
-- migration actually runs in:
--
--   1. REVOKE — the mechanism ADR-0014 names directly, and the one that
--      matters for the production role model (ADR-0016): a non-superuser
--      application role genuinely cannot bypass a REVOKE.
--   2. A row-level trigger that unconditionally rejects UPDATE/DELETE —
--      the mechanism that actually enforces insert-only *in this
--      migration's own local-dev and CI environments*: the official
--      `postgres` Docker image's bootstrap role (`volunteer_portal`
--      locally per docker-compose.yml, `shadow` in CI per
--      .github/workflows/ci.yml) is a Postgres SUPERUSER, and superusers
--      bypass GRANT/REVOKE privilege checks entirely by definition — a
--      REVOKE alone would be silently unenforced here. Triggers, unlike
--      privilege checks, fire for every role regardless of superuser
--      status (a superuser can only escape one deliberately, e.g. via
--      `SET session_replication_role = replica` or `ALTER TABLE ...
--      DISABLE TRIGGER`, not via an ordinary UPDATE/DELETE statement),
--      so this is the layer that makes "verify this actually blocks it"
--      true today. Both layers are kept: REVOKE for the eventual
--      non-superuser production role, the trigger as the real backstop
--      wherever the connecting role is a superuser (every environment
--      this repo currently runs against).
--
-- REVOKE targets CURRENT_USER rather than a literal role name: this
-- migration is applied by whichever role `prisma migrate deploy` connects
-- as, and that role's name differs by environment (`volunteer_portal`
-- locally, `shadow` in CI) — a hardcoded name would make this migration
-- fail with "role does not exist" in whichever environment doesn't use
-- that exact name. CURRENT_USER is standard SQL, supported by PostgreSQL
-- as a role-specification target in REVOKE/GRANT.
-- TRUNCATE is revoked and trigger-blocked too, not just UPDATE/DELETE:
-- TRUNCATE deletes every row just as much as DELETE does (it just does it
-- as a whole-table statement), and per-row (`FOR EACH ROW`) triggers do
-- NOT fire for TRUNCATE at all — confirmed by reproducing it: with only
-- UPDATE/DELETE revoked and trigger-blocked, `TRUNCATE admin.audit_log`
-- silently wiped the table in this same superuser-role environment.
-- PostgreSQL does support a statement-level `BEFORE TRUNCATE` trigger,
-- which is what actually closes this gap below.
REVOKE UPDATE, DELETE, TRUNCATE ON "admin"."audit_log" FROM CURRENT_USER;
REVOKE UPDATE, DELETE, TRUNCATE ON "admin"."audit_log" FROM PUBLIC;

CREATE FUNCTION "admin".audit_log_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin.audit_log is insert-only: % is not permitted (ADR-0014 section 4)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "admin"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "admin".audit_log_prevent_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "admin"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "admin".audit_log_prevent_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "admin"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "admin".audit_log_prevent_mutation();
