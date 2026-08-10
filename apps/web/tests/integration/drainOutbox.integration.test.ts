import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { drainOutbox, type EventHandler } from "@volunteer-portal/outbox";

// Exercises drainOutbox() against a real Postgres connection (ADR-0015
// §"outbox-write-then-drain cycle") in a dedicated throwaway schema —
// the same DDL shape every real `<schema>.domain_events` +
// `processed_events` pair uses (see
// packages/outbox/processed-events.template.sql), created fresh and
// dropped at the end so this is safe to re-run.
const SCHEMA = "outbox_integration_test";
const CONSUMER = "outbox_integration_test.consumer";

interface ToyPayload {
  value: string;
}

describe("drainOutbox (integration)", () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

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
    await client.query(`
      CREATE TABLE "${SCHEMA}".processed_events (
        consumer     text NOT NULL,
        event_id     text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, event_id)
      )
    `);
    await client.query(`
      CREATE TABLE "${SCHEMA}".side_effects (
        id            serial PRIMARY KEY,
        source_event_id text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
    await client.end();
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE "${SCHEMA}".domain_events, "${SCHEMA}".processed_events, "${SCHEMA}".side_effects`);
  });

  async function insertEvent(eventType: string, payload: ToyPayload): Promise<string> {
    const id = newId();
    await client.query(
      `INSERT INTO "${SCHEMA}".domain_events (id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'toy', $1, $2, $3)`,
      [id, eventType, JSON.stringify(payload)],
    );
    return id;
  }

  it("dispatches a matching event to its handler exactly once and marks it processed", async () => {
    const id = await insertEvent("toy.created", { value: "a" });
    let invocations = 0;
    const handler: EventHandler<ToyPayload> = async (event, tx) => {
      invocations += 1;
      await tx.query(`INSERT INTO "${SCHEMA}".side_effects (source_event_id) VALUES ($1)`, [event.id]);
    };

    const result = await drainOutbox({
      client,
      sourceSchema: SCHEMA,
      consumerName: CONSUMER,
      handlers: { "toy.created": handler },
    });

    expect(result).toMatchObject({ drained: 1, skippedDuplicate: 0, skippedUnhandled: 0, failed: 0 });
    expect(invocations).toBe(1);

    const { rows: processedRows } = await client.query(
      `SELECT processed_at FROM "${SCHEMA}".domain_events WHERE id = $1`,
      [id],
    );
    expect(processedRows[0].processed_at).not.toBeNull();

    const { rows: sideEffectRows } = await client.query(
      `SELECT count(*)::int AS count FROM "${SCHEMA}".side_effects WHERE source_event_id = $1`,
      [id],
    );
    expect(sideEffectRows[0].count).toBe(1);
  });

  it("does not re-invoke the handler on redelivery — the processed_events ledger dedupes it", async () => {
    const id = await insertEvent("toy.created", { value: "b" });
    let invocations = 0;
    const handler: EventHandler<ToyPayload> = async () => {
      invocations += 1;
    };
    const options = {
      client,
      sourceSchema: SCHEMA,
      consumerName: CONSUMER,
      handlers: { "toy.created": handler },
    };

    await drainOutbox(options);
    expect(invocations).toBe(1);

    // Simulate redelivery: the row gets re-selected as if processed_at
    // had never been set (e.g. a crash before the poller's own bookkeeping
    // caught up, or a replay).
    await client.query(`UPDATE "${SCHEMA}".domain_events SET processed_at = NULL WHERE id = $1`, [id]);

    const secondResult = await drainOutbox(options);
    expect(secondResult).toMatchObject({ drained: 0, skippedDuplicate: 1, failed: 0 });
    expect(invocations).toBe(1);
  });

  it("marks an event with no registered handler as processed without dispatching or ledger-recording it", async () => {
    const id = await insertEvent("toy.unhandled_type", { value: "c" });

    const result = await drainOutbox({
      client,
      sourceSchema: SCHEMA,
      consumerName: CONSUMER,
      handlers: { "toy.created": async () => {} },
    });

    expect(result).toMatchObject({ drained: 0, skippedUnhandled: 1, skippedDuplicate: 0, failed: 0 });

    const { rows } = await client.query(`SELECT processed_at FROM "${SCHEMA}".domain_events WHERE id = $1`, [id]);
    expect(rows[0].processed_at).not.toBeNull();

    const { rows: ledgerRows } = await client.query(
      `SELECT 1 FROM "${SCHEMA}".processed_events WHERE event_id = $1`,
      [id],
    );
    expect(ledgerRows).toHaveLength(0);
  });

  it("leaves a failed event unprocessed, with no ledger row, for retry — and a later successful run drains it", async () => {
    const id = await insertEvent("toy.flaky", { value: "d" });
    let attemptCount = 0;
    const handler: EventHandler<ToyPayload> = async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        throw new Error("simulated transient failure");
      }
    };
    const options = {
      client,
      sourceSchema: SCHEMA,
      consumerName: CONSUMER,
      handlers: { "toy.flaky": handler },
    };

    const firstResult = await drainOutbox(options);
    expect(firstResult).toMatchObject({ drained: 0, failed: 1 });

    const { rows: afterFailure } = await client.query(
      `SELECT processed_at, attempts FROM "${SCHEMA}".domain_events WHERE id = $1`,
      [id],
    );
    expect(afterFailure[0].processed_at).toBeNull();
    expect(afterFailure[0].attempts).toBe(1);

    const { rows: ledgerAfterFailure } = await client.query(
      `SELECT 1 FROM "${SCHEMA}".processed_events WHERE event_id = $1`,
      [id],
    );
    expect(ledgerAfterFailure).toHaveLength(0); // rolled back with the rest of the failed transaction

    const secondResult = await drainOutbox(options);
    expect(secondResult).toMatchObject({ drained: 1, failed: 0 });
    expect(attemptCount).toBe(2);

    const { rows: afterSuccess } = await client.query(
      `SELECT processed_at FROM "${SCHEMA}".domain_events WHERE id = $1`,
      [id],
    );
    expect(afterSuccess[0].processed_at).not.toBeNull();
  });

  it("respects batchSize, leaving extra unprocessed rows for the next call", async () => {
    await insertEvent("toy.created", { value: "e1" });
    await insertEvent("toy.created", { value: "e2" });
    await insertEvent("toy.created", { value: "e3" });

    const options = {
      client,
      sourceSchema: SCHEMA,
      consumerName: CONSUMER,
      handlers: { "toy.created": (async () => {}) as EventHandler<ToyPayload> },
      batchSize: 2,
    };

    const first = await drainOutbox(options);
    expect(first.drained).toBe(2);

    const second = await drainOutbox(options);
    expect(second.drained).toBe(1);

    const third = await drainOutbox(options);
    expect(third.drained).toBe(0);
  });
});
