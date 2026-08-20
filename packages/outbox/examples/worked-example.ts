/**
 * A real, runnable worked example for `drainOutbox()` — not prose. Run it
 * with:
 *
 *   pnpm outbox:example
 *
 * (from the repo root; needs the local dev Postgres from `pnpm db:up`
 * running — this script loads `DATABASE_URL` from `.env` the same way
 * every other root script does, via `dotenv -e .env --`).
 *
 * What it demonstrates, against a real Postgres connection — no mocks:
 *
 *   1. A toy `outbox_example.domain_events` table (the same shape every
 *      real `<schema>.domain_events` table has) and its
 *      `outbox_example.processed_events` ledger (see
 *      `processed-events.template.sql`), created fresh in their own
 *      throwaway schema.
 *   2. One toy event (`"toy.widget_created"`) inserted, exactly like a
 *      real bounded-context write would insert into its own outbox
 *      inside a transaction.
 *   3. `drainOutbox()` draining it: the registered handler runs once,
 *      recording a row in a `widget_projection` side-effect table.
 *   4. A simulated *redelivery* — `processed_at` reset to `NULL`, as if
 *      the row were re-selected by a second drain run after a crash —
 *      and `drainOutbox()` run again. The handler does **not** run a
 *      second time: the `processed_events` ledger catches it, proving
 *      the idempotency guarantee this package exists to provide.
 *
 * The schema is dropped at the end (success or failure) so this is safe
 * to run repeatedly against a shared local dev database.
 */
import { Client } from "pg";
import { newId } from "@volunteer-portal/ulid";
import { drainOutbox } from "../src/drainOutbox.js";
import type { EventHandler } from "../src/types.js";

const SCHEMA = "outbox_example";
const CONSUMER_NAME = "outbox_example.widget_projector";

interface ToyWidgetCreatedPayload {
  widgetName: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — run via `pnpm --filter @volunteer-portal/outbox example` " +
        "from the repo root (loads .env), with `pnpm db:up` already running.",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // --- 1. Fresh throwaway schema: domain_events + the ledger table ---
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
    // Same DDL as packages/outbox/processed-events.template.sql, inlined
    // here (with the schema substituted) so this file is self-contained.
    await client.query(`
      CREATE TABLE "${SCHEMA}".processed_events (
        consumer     text NOT NULL,
        event_id     text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, event_id)
      )
    `);
    // The handler's side effect: a real projection table, so "did the
    // handler run" is verifiable via a plain SELECT count(*), not a
    // process-local variable a redelivered drain run couldn't see anyway.
    await client.query(`
      CREATE TABLE "${SCHEMA}".widget_projection (
        id           serial PRIMARY KEY,
        source_event_id text NOT NULL,
        widget_name  text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);

    // --- 2. Insert one toy event, as a real producer would ---
    const eventId = newId(); // the same @volunteer-portal/ulid a real producer generates its event id with
    await client.query(
      `INSERT INTO "${SCHEMA}".domain_events (id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        eventId,
        "widget",
        "widget-1",
        "toy.widget_created",
        JSON.stringify({ widgetName: "Sprocket" } satisfies ToyWidgetCreatedPayload),
      ],
    );

    // --- 3. Handler: writes a row into widget_projection using the same
    //        transaction-scoped client drainOutbox() passes in ---
    let handlerInvocations = 0;
    const handleWidgetCreated: EventHandler<ToyWidgetCreatedPayload> = async (event, txClient) => {
      handlerInvocations += 1;
      await txClient.query(
        `INSERT INTO "${SCHEMA}".widget_projection (source_event_id, widget_name) VALUES ($1, $2)`,
        [event.id, event.payload.widgetName],
      );
    };

    const drainOptions = {
      client,
      sourceSchema: SCHEMA,
      consumerName: CONSUMER_NAME,
      handlers: { "toy.widget_created": handleWidgetCreated },
    };

    // --- First drain: handler should run exactly once ---
    const firstRun = await drainOutbox(drainOptions);
    assert(firstRun.drained === 1, `expected 1 drained event, got ${firstRun.drained}`);
    assert(handlerInvocations === 1, `expected handler to run once, ran ${handlerInvocations} times`);

    const { rows: afterFirst } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${SCHEMA}".widget_projection`,
    );
    assert(afterFirst[0].count === "1", `expected 1 projection row after first drain, got ${afterFirst[0].count}`);
    console.log("[1/2] First drain: handler ran once, projection row written. OK.");

    // --- 4. Simulate redelivery: reset processed_at, as if this row got
    //        re-selected by a second drain run after a crash between the
    //        handler committing and the poller correctly skipping it ---
    await client.query(`UPDATE "${SCHEMA}".domain_events SET processed_at = NULL WHERE id = $1`, [eventId]);

    const secondRun = await drainOutbox(drainOptions);
    assert(secondRun.skippedDuplicate === 1, `expected 1 deduped event, got ${secondRun.skippedDuplicate}`);
    assert(secondRun.drained === 0, `expected 0 newly-drained events, got ${secondRun.drained}`);
    assert(handlerInvocations === 1, `expected handler to still have run only once, ran ${handlerInvocations} times`);

    const { rows: afterSecond } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${SCHEMA}".widget_projection`,
    );
    assert(
      afterSecond[0].count === "1",
      `expected projection row count to stay at 1 after redelivery, got ${afterSecond[0].count}`,
    );
    console.log(
      "[2/2] Simulated redelivery: processed_events ledger caught it, handler did NOT run again. OK.",
    );

    console.log("\ndrainOutbox() worked example passed: redelivered events are not double-processed.");
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
