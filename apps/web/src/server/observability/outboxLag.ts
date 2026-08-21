/**
 * apps/web's Prisma-backed half of ADR-0013's outbox-lag metric — runs the
 * real SQL against a `<schema>.domain_events` table and hands the raw
 * numbers to `@volunteer-portal/observability`'s pure `evaluateOutboxLag`
 * for the threshold decision (see that package's `outboxLag.ts` for why
 * the split).
 *
 * Deviates from ADR-0013's Implementation Notes sketch in one detail: the
 * sketch's SQL reads `MIN(created_at)`, but this schema's actual outbox
 * column (`apps/web/prisma/schema.prisma`, every `*DomainEvent` model) is
 * `occurred_at` — using the real column name here.
 */
import type { PrismaClient } from "@prisma/client";
import { metrics } from "@opentelemetry/api";
import { evaluateOutboxLag, type OutboxLagResult, type RawOutboxLagQuery } from "@volunteer-portal/observability";
import { errorReporter } from "./sentry";
import { logger } from "./logger";

/**
 * The eight bounded-context schemas (docs/ddd/00-context-map.md,
 * ADR-0001), each owning its own `domain_events` outbox table. Mirrors
 * `apps/worker/src/schemas.ts`'s own whitelist (kept as a separate literal
 * here rather than a cross-app import — apps/web and apps/worker are
 * separate deployables with no runtime dependency on each other's source).
 * Fixed, code-owned, never derived from user/event input — schema-qualified
 * identifiers built from this list are safe to interpolate directly into
 * SQL, same justification as `apps/worker/src/tasks/audit-log-writer.ts`.
 */
export const BOUNDED_CONTEXT_SCHEMAS = [
  "identity",
  "volunteering",
  "training",
  "gamification",
  "community",
  "moderation",
  "notifications",
  "admin",
] as const;

export type BoundedContextSchema = (typeof BOUNDED_CONTEXT_SCHEMAS)[number];

interface RawRow {
  maxLagSeconds: number | null;
  unprocessedCount: bigint;
}

/** The minimal Prisma surface this needs — real `PrismaClient` or a test double exposing `$queryRawUnsafe`. */
export interface OutboxLagDbClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

/**
 * The raw SQL query, factored out from the whitelist check below —
 * exported so `outboxLag.integration.test.ts` can point it at a throwaway
 * schema/table (same shape as a real `<schema>.domain_events` table, per
 * `packages/outbox/examples/worked-example.ts`'s own precedent) instead of
 * a real bounded-context schema, which several *other* integration test
 * files also write unprocessed rows into concurrently (Vitest runs
 * integration files in parallel against one shared testcontainer Postgres
 * — see `tests/integration/setup.ts`'s doc comment) — a real schema's
 * global `MIN(occurred_at)`/`COUNT(*)` would be flaky to assert exact
 * values against for that reason. `computeOutboxLag` below is what every
 * real call site (including `computeAllOutboxLag`/`registerOutboxLagMetrics`)
 * actually uses, with `schema` narrowed to the trusted whitelist.
 */
export async function queryRawOutboxLag(db: OutboxLagDbClient, schema: string): Promise<RawOutboxLagQuery> {
  const rows = await db.$queryRawUnsafe<RawRow[]>(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::float8 AS "maxLagSeconds", COUNT(*)::bigint AS "unprocessedCount"
       FROM "${schema}".domain_events
      WHERE processed_at IS NULL`,
  );
  const row = rows[0];
  return {
    maxLagSeconds: row?.maxLagSeconds ?? null,
    unprocessedCount: Number(row?.unprocessedCount ?? BigInt(0)),
  };
}

/** Queries one (real, whitelisted) bounded-context schema's `domain_events` table and returns its decided `OutboxLagResult`. */
export async function computeOutboxLag(db: OutboxLagDbClient, schema: BoundedContextSchema): Promise<OutboxLagResult> {
  const raw = await queryRawOutboxLag(db, schema);
  return evaluateOutboxLag(schema, raw);
}

/**
 * Computes every schema's lag, and — per ADR-0013's
 * `reportOutboxLag()` sketch — routes any breach through the error
 * reporter as a page-worthy `captureMessage` (safely no-op'd when
 * `SENTRY_DSN` is unset, exactly like every other `errorReporter` call in
 * this app). Recording the actual OTel gauge is `instrumentation.ts`'s
 * concern (an observable-gauge callback reads the latest `OutboxLagResult`
 * this function returns) — this function's job is the computation +
 * alerting decision, which is what's under test here, not metric delivery
 * to a live OTel backend.
 */
export async function reportOutboxLag(db: OutboxLagDbClient, schema: BoundedContextSchema): Promise<OutboxLagResult> {
  const result = await computeOutboxLag(db, schema);
  if (result.needsAlert) {
    errorReporter.captureMessage(
      `Outbox drain lag exceeded 10min for ${schema} (${Math.round(result.maxLagSeconds)}s, ${result.unprocessedCount} unprocessed)`,
      "error",
    );
  }
  return result;
}

/** Convenience: every schema's `OutboxLagResult`, for a "platform health" dashboard panel (ADR-0013). */
export async function computeAllOutboxLag(db: PrismaClient): Promise<OutboxLagResult[]> {
  return Promise.all(BOUNDED_CONTEXT_SCHEMAS.map((schema) => computeOutboxLag(db, schema)));
}

let registered = false;

/**
 * Registers `outbox.lag_seconds.<schema>` as a real OTel observable gauge
 * per schema (ADR-0013's Implementation Notes `reportOutboxLag()` sketch),
 * called once from `src/instrumentation.ts`'s `register()`. `@opentelemetry/api`'s
 * global `MeterProvider` is a safe no-op until `registerOTel()` (also
 * called from `instrumentation.ts`) installs a real one, so this never
 * throws or attempts a network call on its own — and every per-schema
 * callback below independently catches its own DB-query failure so one
 * schema's error can't blank out every other schema's gauge reading.
 */
export function registerOutboxLagMetrics(db: PrismaClient): void {
  if (registered) return;
  registered = true;
  const meter = metrics.getMeter("volunteer-portal");
  for (const schema of BOUNDED_CONTEXT_SCHEMAS) {
    meter.createObservableGauge(`outbox.lag_seconds.${schema}`).addCallback(async (result) => {
      try {
        const lag = await reportOutboxLag(db, schema);
        result.observe(lag.maxLagSeconds, { schema });
      } catch (error) {
        logger.error("observability.outbox_lag_metric_failed", {
          context: { schema, message: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  }
}
