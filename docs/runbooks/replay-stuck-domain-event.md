# Runbook: Replay a stuck domain event

**When to use this**: `docs/runbooks/outbox-drain-health.md` found a specific
`<schema>.domain_events` row that's genuinely stuck (not just waiting on the next
poll cycle) — either the handler keeps throwing and exhausting its retries, or the
worker was down long enough that you want to force an immediate redrive instead of
waiting for the next 5s/poll-interval cycle.

Read `packages/outbox/src/drainOutbox.ts`'s and `apps/worker/src/tasks/audit-log-writer.ts`'s
header comments before touching production data — the idempotency guarantees below
depend on the exact mechanism each consumer uses, and using the wrong one for a given
consumer can double-apply a side effect.

## Step 1: Identify the consumer and its idempotency mechanism

This codebase has two outbox-consumer shapes, and the safe replay procedure differs:

1. **`audit_log_writer`** (`apps/worker/src/tasks/audit-log-writer.ts`) — the only
   currently-registered consumer. Idempotent because it inserts into
   `admin.audit_log` using the *source event's own `id`* as the audit-log row's
   primary key, with `ON CONFLICT (id) DO NOTHING`. A redelivery of the same event id
   can never double-write the audit log, no matter how many times it's replayed.
2. **`@volunteer-portal/outbox`'s generic `drainOutbox()`** (`packages/outbox/src/drainOutbox.ts`) —
   for any future consumer built on this package. Idempotent via a
   `(consumer, event_id)` row in that consumer's `processed_events` ledger table,
   inserted with `ON CONFLICT (consumer, event_id) DO NOTHING` in the same transaction
   as the handler's own writes and the `processed_at` update.

Either way: **do not manually re-run a handler's side effect by hand** (e.g. manually
calling `resendAdapter.sendTransactionalEmail` again, or manually inserting into
`admin.audit_log`) — that bypasses the idempotency ledger and *will* double-apply the
side effect. The safe replay path is always "make the row eligible for the consumer
to pick up again," never "re-execute the side effect yourself."

## Step 2: Confirm the row is actually eligible for a natural retry first

Both consumer shapes above already retry automatically on the next poll as long as
`processed_at IS NULL` — a "stuck" row is usually not stuck because nothing will ever
retry it, but because it keeps failing on retry (check `attempts` and the worker's
structured error logs per the outbox-health runbook) or because the worker process
itself was down. If the worker is back up and the row's `attempts` is climbing, **wait
for the next natural poll cycle** (`audit_log_writer` self-reschedules every 5s —
`POLL_INTERVAL_MS` in `apps/worker/src/tasks/audit-log-writer.ts`) rather than manually
intervening — you'll get the same idempotent outcome with less risk.

Only proceed to Step 3 if the underlying cause (a bad handler, a downstream outage)
has been fixed and the row is *still* sitting unprocessed, or if you need it applied
immediately rather than waiting.

## Step 3: Force an immediate redrive

**Option A — restart the worker process.** `audit_log_writer` re-enqueues itself on
every run and graphile-worker picks up any `processed_at IS NULL` row on its next
scheduled scan regardless of restart; a worker restart alone is often enough once the
root cause is fixed, with zero manual SQL.

**Option B — manually enqueue an immediate graphile-worker job**, if you don't want to
wait even 5 seconds (e.g. an incident actively blocking a volunteer):

```sql
-- Forces audit_log_writer to run right now instead of waiting for its next
-- self-scheduled run.
SELECT graphile_worker.add_job('audit_log_writer', run_at => now());
```

**Option C — the row's `processed_at` was incorrectly set (a bug, a bad manual fix)
and needs to be reset so a consumer picks it back up.** This is the one case where you
edit `domain_events` directly — safe *only* because both consumer shapes' idempotency
keys are on the event's own `id`, which doesn't change:

```sql
UPDATE "notifications".domain_events
   SET processed_at = NULL
 WHERE id = '<the stuck event's ULID>';
```

Then use Option A or B to trigger an immediate redrive, or wait for the next poll.

## Step 4: Verify

Re-run the outbox-health query from `docs/runbooks/outbox-drain-health.md` for the
affected schema and confirm the row's `processed_at` is now set, and (for
`audit_log_writer` specifically) that the matching row exists in `admin.audit_log`:

```sql
SELECT id, action, resource_type, resource_id, occurred_at
  FROM admin.audit_log
 WHERE id = '<the same ULID>';
```

Because the audit-log insert reuses the source event's `id`, this is a direct,
unambiguous correlation — the ids match exactly.

## Step 5: If the handler itself is broken

If the row keeps failing after a redrive, the fix belongs in code, not in more manual
SQL — check `attempts` and the structured error log line's `context` for the specific
exception, fix the handler, deploy, then redrive per Step 3. Do not keep force-retrying
a row against a handler you know is broken; each attempt increments `attempts` and
adds noise to the drain worker's own error logs without resolving anything.
