# @volunteer-portal/outbox

A generic transactional-outbox drain helper (ADR-0009) for any bounded
context that needs to poll its own `<schema>.domain_events` table and
dispatch unprocessed rows to registered handlers — **idempotently**, even
under at-least-once redelivery. This is the pattern apps/worker's
`audit_log_writer` task hand-wrote for draining into `admin.audit_log`
(see `apps/worker/src/tasks/audit-log-writer.ts`), pulled out here so the
next five-plus consumers don't each re-derive it.

## Why a `processed_events` ledger, when `domain_events.processed_at` already exists?

`domain_events.processed_at IS NULL` already keeps a row that this same
consumer already committed from being re-selected. Two real reasons the
ledger exists on top of that:

1. **Multiple independent consumers, one source table.** The simplified
   outbox shape every `<schema>.domain_events` table currently uses (see
   `schema.prisma`'s comment) has exactly one `processed_at` bit per row —
   it can't represent "consumer A is done, consumer B isn't yet." A
   `processed_events` ledger, keyed by `(consumer, event_id)`, scopes
   "have I handled this" *per consumer* instead of per row, which is what
   lets two unrelated consumers drain the same table safely without
   ADR-0009's fuller multi-subscriber relay table needing to exist yet.
2. **A genuine idempotency backstop, not just an optimization.** If
   `processed_at` is ever reset — a manual data fix, a bug, replaying from
   a backup — the ledger still remembers this consumer already ran its
   handler for that event id, and skips re-invoking it. `audit_log_writer`
   gets this same property for free by reusing the source event's id as
   `admin.audit_log`'s own primary key; `drainOutbox()` generalizes it for
   handlers whose side effects have no natural dedupe key of their own.

## Setting up a new consumer

1. **Your schema already has (or gets) a `domain_events` table** in the
   standard shape (`id`, `aggregate_type`, `aggregate_id`, `event_type`,
   `payload`, `occurred_at`, `processed_at`, `attempts` — see
   `apps/web/prisma/schema.prisma`'s `IdentityDomainEvent` model for the
   canonical shape every schema copies).
2. **Add a `processed_events` ledger table to your own schema's
   migration.** Copy `processed-events.template.sql` from this package,
   substituting your schema name, and add a matching Prisma `model` (see
   that file's own comment for why both are needed).
3. **Write a graphile-worker task that calls `drainOutbox()`**, following
   `audit_log_writer`'s self-rescheduling pattern
   (`apps/worker/src/tasks/audit-log-writer.ts`):

   ```ts
   import type { Task, JobHelpers } from "graphile-worker";
   import { drainOutbox } from "@volunteer-portal/outbox";
   import { handleWidgetCreated } from "./handlers/widget-created.js";

   export const widgetProjector: Task = async (_payload, helpers: JobHelpers) => {
     await helpers.withPgClient(async (pgClient) => {
       const result = await drainOutbox({
         client: pgClient,
         sourceSchema: "volunteering",
         consumerName: "gamification.widget_projector",
         handlers: { "widget.created": handleWidgetCreated },
         logger: helpers.logger,
       });
       if (result.drained > 0) {
         helpers.logger.info(`widget_projector: drained ${result.drained} event(s)`);
       }
     });
     // ...then self-reschedule via helpers.addJob with jobKeyMode: "replace",
     // exactly like audit_log_writer does.
   };
   ```

   `client` **must** be a single dedicated connection (`helpers.withPgClient`'s
   callback argument, or a `pg` `PoolClient` you checked out yourself) — never
   a bare `Pool`. `drainOutbox()` issues `BEGIN`/`COMMIT`/`ROLLBACK` as
   separate statements on that same object; a pool that round-robins
   connections per `.query()` call would silently break atomicity.

## Idempotency, precisely

`drainOutbox()` guarantees: **for a given `(consumerName, event.id)` pair,
your handler runs at most once across however many times this drain loop
picks the row up.** It does **not** by itself guarantee your handler's
*non-Postgres* side effects (an outbound email, a webhook call) are
exactly-once — if your handler does Postgres writes using the `client`
it's given, those commit atomically with the ledger row and the
`processed_at` update, so a crash anywhere in that transaction rolls
everything back together and the event is genuinely retried from scratch.
If your handler's only effect is calling an external API, that call can
still happen twice in the crash-between-the-external-call-and-the-commit
window — the standard at-least-once caveat (ADR-0009 "idempotent handlers
are mandatory"). Make such calls idempotent at the destination (an
idempotency key, an upsert) if that matters for your use case.

## Worked example (real, runnable)

`examples/worked-example.ts` is not prose — it runs against a real
Postgres connection (the same local dev database from `pnpm db:up`),
creating its own throwaway `outbox_example` schema, and proves the
redelivery guarantee above by actually triggering a redelivery. Run it
yourself:

```
pnpm outbox:example
```

What it does, step by step:

1. Creates `outbox_example.domain_events`, `outbox_example.processed_events`,
   and a `widget_projection` side-effect table (in a fresh schema, dropped
   at the end).
2. Inserts one toy event: `event_type = "toy.widget_created"`.
3. Registers a handler that inserts a row into `widget_projection` using
   the same transaction-scoped client `drainOutbox()` gives it, and calls
   `drainOutbox()`. The handler runs once; `widget_projection` has one row.
4. **Resets `processed_at` back to `NULL`** on that same event — simulating
   the row being redelivered to this consumer a second time — and calls
   `drainOutbox()` again.
5. Asserts the handler did **not** run a second time (`skippedDuplicate: 1`,
   `drained: 0`) and `widget_projection` still has exactly one row.

Actual output from a real run against the local dev Postgres:

```
$ pnpm outbox:example
[1/2] First drain: handler ran once, projection row written. OK.
outbox[outbox_example.widget_projector]: "outbox_example".domain_events id=01KZPJW237PMB8RSXPPCASGNMS already in "outbox_example".processed_events; skipping handler (redelivery)
[2/2] Simulated redelivery: processed_events ledger caught it, handler did NOT run again. OK.

drainOutbox() worked example passed: redelivered events are not double-processed.
```

The middle line is `drainOutbox()`'s own log output (from the default
`console` logger) on the second run — the ledger dedupe firing exactly as
described above, not a canned message the example prints itself.

## API

```ts
import { drainOutbox } from "@volunteer-portal/outbox";
import type {
  DrainOutboxOptions,
  DrainOutboxResult,
  OutboxEvent,
  EventHandler,
  PgQueryable,
} from "@volunteer-portal/outbox";

const result: DrainOutboxResult = await drainOutbox({
  client,           // PgQueryable — a single dedicated Postgres connection
  sourceSchema,     // schema owning the domain_events table being drained
  ledgerSchema,     // optional, defaults to sourceSchema
  consumerName,     // stable, unique identifier for this consumer
  handlers,         // event_type => EventHandler map
  batchSize,        // optional, default 100
  logger,           // optional, defaults to console
});
// result: { drained, skippedDuplicate, skippedUnhandled, failed }
```

See `src/types.ts` for full doc comments on every field.

## What this package deliberately does not do

- **It does not create your `processed_events` table.** This package has
  no schema of its own to own it in (ADR-0001) — copy
  `processed-events.template.sql` into your own migration.
- **It does not fan an event out to more than one handler per `event_type`.**
  One handler per type, registered once. If you need several independent
  reactions to the same event type, either compose them inside one handler
  or register the same source table under two different `consumerName`s.
- **It is not the fuller multi-subscriber relay ADR-0009 sketches**
  (`domain_event_dispatches`, `dispatched_at`, `last_error` per
  subscriber). This package's per-consumer `processed_events` ledger
  covers real multi-consumer draining of one table today; the fuller relay
  bookkeeping is deferred until a use case needs its extra guarantees
  (e.g. per-subscriber retry/backoff visibility).
