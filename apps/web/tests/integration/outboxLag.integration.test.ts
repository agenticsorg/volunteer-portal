import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { OUTBOX_LAG_ALERT_THRESHOLD_SECONDS, evaluateOutboxLag } from "@volunteer-portal/observability";
import { queryRawOutboxLag, computeOutboxLag } from "@/server/observability/outboxLag";

// ADR-0013's outbox-lag metric (Implementation Notes `reportOutboxLag()`
// sketch), exercised against a real Postgres in a dedicated throwaway
// schema — same DDL shape every real `<schema>.domain_events` table uses,
// same isolation precedent as `drainOutbox.integration.test.ts` and
// `packages/outbox/examples/worked-example.ts`. A throwaway schema (rather
// than a real bounded-context one) is deliberate: several other
// integration test files write unprocessed rows into the real schemas
// concurrently (Vitest runs integration files in parallel against one
// shared testcontainer Postgres), which would make an exact
// `MIN(occurred_at)`/`COUNT(*)` assertion against a shared schema flaky —
// see `server/observability/outboxLag.ts`'s doc comment on
// `queryRawOutboxLag`.
const SCHEMA = "outbox_lag_integration_test";

describe("outbox lag (integration)", () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`
      CREATE TABLE "${SCHEMA}".domain_events (
        id             text PRIMARY KEY,
        aggregate_type text NOT NULL,
        aggregate_id   text NOT NULL,
        event_type     text NOT NULL,
        payload        jsonb NOT NULL,
        occurred_at    timestamptz NOT NULL DEFAULT now(),
        processed_at   timestamptz,
        attempts       int NOT NULL DEFAULT 0
      )
    `);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
    await client.end();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE "${SCHEMA}".domain_events`);
  });

  async function insertEvent(occurredAtSecondsAgo: number, processed: boolean) {
    await client.query(
      `INSERT INTO "${SCHEMA}".domain_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, processed_at)
       VALUES ($1, 'Toy', $2, 'toy.created', '{}'::jsonb, now() - ($3 || ' seconds')::interval, ${processed ? "now()" : "NULL"})`,
      [newId(), newId(), occurredAtSecondsAgo],
    );
  }

  it("reports zero lag and no unprocessed rows for an empty (fully drained) table", async () => {
    const result = await queryRawOutboxLag(prisma, SCHEMA);
    expect(result).toEqual({ maxLagSeconds: null, unprocessedCount: 0 });
  });

  it("computes the real lag in seconds for a genuinely stale unprocessed row, and flags it for alert", async () => {
    const staleSeconds = OUTBOX_LAG_ALERT_THRESHOLD_SECONDS + 120; // 720s — well past the 600s hard-alert threshold
    await insertEvent(staleSeconds, false);

    const raw = await queryRawOutboxLag(prisma, SCHEMA);
    expect(raw.unprocessedCount).toBe(1);
    // Real elapsed wall-clock time since the INSERT — allow slack either
    // direction for query/transaction overhead.
    expect(raw.maxLagSeconds).toBeGreaterThanOrEqual(staleSeconds - 5);
    expect(raw.maxLagSeconds).toBeLessThanOrEqual(staleSeconds + 15);

    // computeOutboxLag() itself — the exact function every real call site
    // (computeAllOutboxLag/registerOutboxLagMetrics) uses — composed on
    // top of the same raw query. Its public signature only accepts the
    // real 8 bounded-context schema names (a deliberate whitelist, see
    // outboxLag.ts's doc comment); this test-only cast points it at this
    // file's own throwaway schema instead, to prove the composition
    // (query → evaluateOutboxLag's threshold decision) end to end without
    // the cross-test-file flakiness a real shared schema would have.
    const evaluated = await computeOutboxLag(prisma, SCHEMA as Parameters<typeof computeOutboxLag>[1]);
    expect(evaluated.needsAlert).toBe(true);
    expect(evaluated.unprocessedCount).toBe(1);
  });

  it("does not flag a fresh unprocessed row (well under the threshold) for alert", async () => {
    await insertEvent(5, false);

    const raw = await queryRawOutboxLag(prisma, SCHEMA);
    const evaluated = evaluateOutboxLag(SCHEMA, raw);

    expect(evaluated.needsAlert).toBe(false);
    expect(evaluated.maxLagSeconds).toBeGreaterThanOrEqual(0);
    expect(evaluated.maxLagSeconds).toBeLessThan(60);
  });

  it("only counts unprocessed rows — a processed stale row does not inflate the lag", async () => {
    await insertEvent(9000, true); // long-processed, must be excluded
    await insertEvent(3, false); // the only row that should count

    const raw = await queryRawOutboxLag(prisma, SCHEMA);
    expect(raw.unprocessedCount).toBe(1);
    expect(raw.maxLagSeconds).toBeLessThan(60);
  });
});
