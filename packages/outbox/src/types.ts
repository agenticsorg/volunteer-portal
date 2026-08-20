/**
 * @volunteer-portal/outbox — shared types.
 *
 * See `drainOutbox.ts` for the full design rationale. Kept in their own
 * module so consumers (e.g. a graphile-worker task in apps/worker) can
 * import just the types without pulling in the drain implementation.
 */

/**
 * The minimal shape this package needs from a Postgres client — a single,
 * already-connected connection capable of running parameterized queries
 * and `BEGIN`/`COMMIT`/`ROLLBACK`.
 *
 * Deliberately structural rather than importing `pg`'s `PoolClient` type:
 * this package has no runtime dependency on `pg` (only the worked example
 * and tests do), so any driver whose client shape matches this — `pg`'s
 * `Pool`/`PoolClient`/`Client`, graphile-worker's `JobHelpers.withPgClient`
 * callback argument, or a test double — satisfies it for free.
 *
 * IMPORTANT: `client` must be a *single dedicated connection*, not a bare
 * connection pool. `drainOutbox()` issues `BEGIN`/`COMMIT`/`ROLLBACK` as
 * separate statements on the same object it queries with; a pool that
 * round-robins each `.query()` call across different underlying
 * connections would silently break transactional atomicity. Check a
 * client out of your pool first (`pg`'s `pool.connect()`, or
 * graphile-worker's `helpers.withPgClient`) and pass that.
 */
export interface PgQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** A row read from a `<schema>.domain_events` outbox table (ADR-0009). */
export interface OutboxEvent<TPayload = Record<string, unknown>> {
  /** ULID, chronologically sortable — also the dedupe key in `processed_events`. */
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  occurredAt: Date;
  /** How many times this row has been picked up by a drain run, successful or not. */
  attempts: number;
}

/**
 * Handles one event of a given `eventType`. Receives the same
 * transaction-scoped `client` the ledger insert and `processed_at` update
 * run in, so a handler that performs its own Postgres writes (e.g.
 * updating a projection table in the consumer's own schema) gets true
 * atomicity: the handler's writes, the `processed_events` ledger row, and
 * marking the source event processed all commit or roll back together.
 *
 * A handler that only performs non-Postgres side effects (an outbound
 * email, a webhook) does not get that same atomicity from Postgres alone
 * — the ledger row guards against *this drain loop* re-invoking the
 * handler for the same event, but the side effect itself must still be
 * safe to run at-least-once if the process crashes between the side
 * effect executing and this transaction committing. See the package
 * README's "Idempotency, precisely" section.
 *
 * Throwing rolls back the whole per-event transaction (ledger insert +
 * any writes the handler made + the `processed_at` update), leaving the
 * event unprocessed for retry on the next poll.
 */
export type EventHandler<TPayload = Record<string, unknown>> = (
  event: OutboxEvent<TPayload>,
  client: PgQueryable,
) => Promise<void>;

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface DrainOutboxOptions {
  /** A single dedicated Postgres connection — see `PgQueryable`'s doc comment. */
  client: PgQueryable;
  /** The schema owning the `domain_events` table being drained, e.g. `"volunteering"`. */
  sourceSchema: string;
  /**
   * The schema owning this consumer's `processed_events` ledger table.
   * Defaults to `sourceSchema` (the common case: a schema draining its
   * own outbox). Pass a different value only if your consumer's ledger
   * genuinely lives in another schema you own.
   */
  ledgerSchema?: string;
  /**
   * Identifies this consumer in the `processed_events` ledger
   * (`processed_events.consumer`). Must be stable across deploys and
   * unique per logical consumer — two different consumers draining the
   * same `domain_events` table (fan-out) must use different
   * `consumerName`s, or they will incorrectly dedupe each other's work.
   */
  consumerName: string;
  /**
   * `event_type` → handler map. An event whose `event_type` has no
   * registered handler is marked processed without being dispatched or
   * added to the ledger (there is no side effect to dedupe) — this lets a
   * consumer drain a table it only partially cares about without erroring
   * on event types added later by other consumers.
   *
   * Typed `EventHandler<any>` deliberately: this map is a heterogeneous,
   * runtime-`event_type`-keyed dispatch table, so no single payload type
   * applies to every entry. Each handler you register can still declare
   * its own concrete `OutboxEvent<YourPayloadShape>` parameter type for
   * its own body — `any` here only turns off cross-checking *between*
   * unrelated handlers, which there is nothing meaningful to check.
   */
  handlers: Record<string, EventHandler<any>>;
  /** Rows drained per call, keeping each per-run transaction set short. Default 100. */
  batchSize?: number;
  /** Defaults to `console`. */
  logger?: Logger;
}

export interface DrainOutboxResult {
  /** Handler ran successfully for this event. */
  drained: number;
  /** Event was already in the `processed_events` ledger; handler was skipped. */
  skippedDuplicate: number;
  /** No handler registered for the event's `event_type`. */
  skippedUnhandled: number;
  /** Handler (or the transaction) threw; event left unprocessed for retry. */
  failed: number;
}
