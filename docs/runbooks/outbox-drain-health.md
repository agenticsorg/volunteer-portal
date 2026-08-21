# Runbook: Check outbox drain health per schema

**Symptom this addresses**: notifications, badge awards, audit-log entries, or any
other async side effect of a domain event feel "stuck" or delayed. ADR-0013's SLO:
outbox drain lag p95 < 60s, **hard alert at > 10 min**
(`OUTBOX_LAG_ALERT_THRESHOLD_SECONDS` in
`packages/observability/src/outboxLag.ts`).

## Background

Every bounded context owns its own `<schema>.domain_events` outbox table (ADR-0009),
one per schema in
`apps/worker/src/schemas.ts` / `apps/web/src/server/observability/outboxLag.ts`'s
`BOUNDED_CONTEXT_SCHEMAS`:

```
identity, volunteering, training, gamification, community, moderation, notifications, admin
```

A row is "stuck" for as long as `processed_at IS NULL`. Lag is measured as
`now() - MIN(occurred_at)` over a schema's unprocessed rows — see
`apps/web/src/server/observability/outboxLag.ts`'s `queryRawOutboxLag`, which is the
literal SQL below, and `packages/observability/src/outboxLag.ts`'s `evaluateOutboxLag`
for the threshold decision.

## 1. Check the metric in-app (no live OTel backend required)

`computeAllOutboxLag(prisma)` (`apps/web/src/server/observability/outboxLag.ts`) runs
this exact query against every schema and returns each one's
`{ schema, maxLagSeconds, unprocessedCount, needsAlert }`. This is also what backs
`outbox.lag_seconds.<schema>`, the OTel observable gauge
`registerOutboxLagMetrics()` registers from `apps/web/src/instrumentation.ts` — the
gauge is only actually scraped in an environment with a real OTLP collector/Sentry
tracing backend configured (`OTEL_EXPORTER_OTLP_ENDPOINT`), which this environment
does not have. The SQL and the alert decision are real either way; only export to an
external dashboard is what's unconfigured.

## 2. Check it directly against Postgres

Connect to the app's Postgres (local: `docker compose up -d` per the root
`package.json`'s `db:up`, default `postgresql://volunteer_portal:volunteer_portal@localhost:5432/volunteer_portal`
per `docker-compose.yml`; staging/prod: the Neon connection string from that
environment's `DATABASE_URL`, per ADR-0016) and run, per schema:

```sql
SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::float8 AS "maxLagSeconds",
       COUNT(*)::bigint AS "unprocessedCount"
  FROM "notifications".domain_events
 WHERE processed_at IS NULL;
```

Swap the schema name for any of the eight listed above. `maxLagSeconds` above 600
(10 minutes) is the hard-alert threshold; `unprocessedCount` growing across repeated
checks (rather than draining back toward zero) means the consumer isn't keeping up,
even if the *oldest* row's lag hasn't yet crossed the threshold.

To see the actual stuck rows rather than just the aggregate:

```sql
SELECT id, aggregate_type, aggregate_id, event_type, occurred_at, attempts
  FROM "notifications".domain_events
 WHERE processed_at IS NULL
 ORDER BY occurred_at
 LIMIT 20;
```

`attempts` climbing on the same row across repeated checks (rather than the row
disappearing) means a consumer is actively picking it up and failing, not simply
never being polled — see "Diagnose" below.

## 3. Confirm the worker process is actually running

Every schema's outbox is drained by a graphile-worker task running in
`apps/worker` (`apps/worker/src/index.ts`, started via `pnpm worker:start` /
`pnpm worker:dev` from the repo root, or the persistent Fly.io process in
staging/prod per ADR-0016). If the worker process itself is down, **every** schema's
lag grows simultaneously — check that first before treating this as a
per-schema/per-handler bug:

```sql
-- graphile-worker's own job table (its schema is set by GRAPHILE_WORKER_SCHEMA;
-- defaults to "graphile_worker" if unset) — jobs piling up with no recent
-- `locked_at` activity means nothing is polling.
SELECT id, task_identifier, run_at, attempts, last_error, locked_at
  FROM graphile_worker.jobs
 ORDER BY run_at
 LIMIT 20;
```

## 4. Diagnose

- **Worker process down** — restart it (`pnpm worker:start` locally; redeploy/restart
  the Fly.io machine in staging/prod — see ADR-0016's environment topology table).
- **A specific event type has no registered handler in this consumer** — per
  `packages/outbox/src/drainOutbox.ts`'s own contract, an event whose `event_type` has
  no registered handler is marked `processed_at` immediately (not left stuck), so this
  is *not* a cause of stuck rows — rule it out quickly and move on.
- **A handler is throwing** — `packages/outbox/src/drainOutbox.ts` rolls back the
  whole per-event transaction on a handler exception and leaves the row unprocessed
  for retry, incrementing `attempts`. Check the worker's structured logs (JSON lines,
  `apps/worker/src/observability/logger.ts`) for `event: "..."` entries with
  `level: "error"` around the stuck row's `event_type`/`id`; `withJobErrorCapture`
  (`apps/worker/src/observability/withJobErrorCapture.ts`) routes every uncaught job
  exception through the same structured log + Sentry error-reporter path (Sentry
  capture only fires when `SENTRY_DSN` is configured — see
  `apps/worker/src/observability/sentry.ts`).
- **`audit_log_writer` specifically** (`apps/worker/src/tasks/audit-log-writer.ts`)
  only drains rows tagged `payload @> '{"audit": true}'` — an audit-tagged row stuck
  here does not affect non-audit consumers of the same schema's outbox, and vice
  versa. Check `admin.audit_log` for the expected row by the shared event id (see the
  replay runbook below for a worked idempotency example — this consumer reuses the
  source event's `id` as the audit-log row's own primary key).

## 5. Escalation

Per ADR-0013's alerting tiers: outbox drain lag **> 10 min is page-worthy**
(the highest tier — see `docs/runbooks/on-call-and-alerting.md`). A lag between the
60s p95 target and 10 minutes, sustained over an hour, is ticket-worthy, not an
immediate page.

If the stuck row needs to be manually re-driven rather than waiting on the next
worker poll cycle, see `docs/runbooks/replay-stuck-domain-event.md`.
