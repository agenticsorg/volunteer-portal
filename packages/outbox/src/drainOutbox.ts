/**
 * @volunteer-portal/outbox — drainOutbox()
 *
 * A generic transactional-outbox drain loop (ADR-0009), for any bounded
 * context that needs to poll its own `<schema>.domain_events` table and
 * dispatch unprocessed rows to registered handlers. This is the same
 * pattern apps/worker's `audit_log_writer` task hand-wrote for
 * `admin.audit_log` (see apps/worker/src/tasks/audit-log-writer.ts) —
 * pulled out here so the five-plus future consumers (leaderboard
 * projections reacting to `volunteering` events, notification digests
 * reacting to `community` events, etc.) don't each re-derive it.
 *
 * ## Idempotency, precisely
 *
 * `domain_events.processed_at IS NULL` already keeps a *successfully
 * committed* row from being re-selected by this same consumer — so why a
 * separate `processed_events` ledger table at all? Two reasons:
 *
 * 1. **Multiple independent consumers, one source table.** ADR-0009's
 *    simplified single-`processed_at`-column outbox shape (the one this
 *    phase's `domain_events` tables use — see schema.prisma's comment)
 *    supports exactly one implicit "processed" bit per row. The moment a
 *    second consumer wants to drain the *same* `domain_events` table for
 *    a different purpose (real multi-subscriber fan-out), one shared
 *    `processed_at` column can't represent "consumer A is done but
 *    consumer B isn't yet." `processed_events`, keyed by
 *    `(consumer, event_id)`, scopes "have I handled this" per consumer
 *    instead of per row, so this doesn't require ADR-0009's fuller
 *    `domain_event_dispatches` relay table to already exist.
 * 2. **A true idempotency backstop, not just a happy-path optimization.**
 *    If a `processed_at` value is ever reset (a manual data fix, a bug, a
 *    replay-from-a-backup scenario), the ledger still remembers this
 *    consumer already ran its handler for that event id and skips
 *    re-invoking it — exactly the property `audit_log_writer` gets for
 *    free by reusing the source event's id as `admin.audit_log`'s own
 *    primary key (`ON CONFLICT (id) DO NOTHING`), generalized for
 *    handlers whose side effects have no such natural dedupe key of their
 *    own. The package README has a runnable demonstration of this exact
 *    scenario.
 *
 * Every event is processed inside its own short transaction: the ledger
 * insert, the handler's own work (if it does Postgres writes, via the
 * same `client`), and marking `domain_events.processed_at` all commit or
 * roll back together — the same all-or-nothing unit `audit_log_writer`
 * uses. A failure rolls back the ledger insert too, so a failed event is
 * genuinely retried (not skipped as "already processed") on the next
 * poll.
 */
import type {
  DrainOutboxOptions,
  DrainOutboxResult,
  OutboxEvent,
  PgQueryable,
} from "./types.js";

const DEFAULT_BATCH_SIZE = 100;

interface RawDomainEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

async function markProcessed(
  client: PgQueryable,
  sourceSchema: string,
  eventId: string,
): Promise<void> {
  // Schema-qualified identifier interpolation is safe here: `sourceSchema`
  // is always a caller-supplied literal identifying a schema *they own*,
  // never end-user/event input — the same precedent as
  // apps/worker/src/tasks/audit-log-writer.ts's `drainSchema()`.
  await client.query(
    `UPDATE "${sourceSchema}".domain_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`,
    [eventId],
  );
}

/**
 * Drains up to `options.batchSize` unprocessed rows from
 * `"${options.sourceSchema}".domain_events`, dispatching each to
 * `options.handlers[event.eventType]` if one is registered. Returns
 * counts of what happened to each row (see `DrainOutboxResult`) — callers
 * (typically a graphile-worker task) decide what to log/self-reschedule
 * on, matching `audit_log_writer`'s own self-rescheduling pattern.
 *
 * Never throws for a single event's handler failure — that event is
 * counted in `result.failed` and left unprocessed for the next call to
 * retry. Only rejects if the initial `SELECT` itself fails (e.g. the
 * connection drops), since at that point no partial progress was made.
 */
export async function drainOutbox(
  options: DrainOutboxOptions,
): Promise<DrainOutboxResult> {
  const {
    client,
    sourceSchema,
    ledgerSchema = sourceSchema,
    consumerName,
    handlers,
    batchSize = DEFAULT_BATCH_SIZE,
    logger = console,
  } = options;

  const result: DrainOutboxResult = {
    drained: 0,
    skippedDuplicate: 0,
    skippedUnhandled: 0,
    failed: 0,
  };

  const { rows } = await client.query<RawDomainEventRow>(
    `SELECT id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts
       FROM "${sourceSchema}".domain_events
      WHERE processed_at IS NULL
      ORDER BY id
      LIMIT $1`,
    [batchSize],
  );

  for (const row of rows) {
    const event: OutboxEvent = {
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
    };

    const handler = handlers[event.eventType];

    if (!handler) {
      await markProcessed(client, sourceSchema, event.id);
      result.skippedUnhandled += 1;
      continue;
    }

    try {
      await client.query("BEGIN");

      const { rows: ledgerRows } = await client.query<{ event_id: string }>(
        `INSERT INTO "${ledgerSchema}".processed_events (consumer, event_id)
              VALUES ($1, $2)
         ON CONFLICT (consumer, event_id) DO NOTHING
         RETURNING event_id`,
        [consumerName, event.id],
      );
      const alreadyProcessed = ledgerRows.length === 0;

      if (alreadyProcessed) {
        logger.info(
          `outbox[${consumerName}]: "${sourceSchema}".domain_events id=${event.id} already in "${ledgerSchema}".processed_events; skipping handler (redelivery)`,
        );
      } else {
        await handler(event, client);
      }

      await markProcessed(client, sourceSchema, event.id);
      await client.query("COMMIT");

      if (alreadyProcessed) {
        result.skippedDuplicate += 1;
      } else {
        result.drained += 1;
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        /* connection may already be dead; nothing more to do */
      });
      // Record the failed attempt outside the rolled-back transaction so
      // `attempts` is still observable — best-effort: if even this fails,
      // the event remains unprocessed and will be retried regardless.
      await client
        .query(
          `UPDATE "${sourceSchema}".domain_events SET attempts = attempts + 1 WHERE id = $1`,
          [event.id],
        )
        .catch(() => {});
      logger.error(
        `outbox[${consumerName}]: failed to drain "${sourceSchema}".domain_events id=${event.id}: ${(err as Error).message}`,
      );
      result.failed += 1;
    }
  }

  return result;
}
