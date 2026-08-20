# ADR-0009: Cross-Context Integration — Transactional Outbox + graphile-worker

## Status
Accepted — 2026-08-10

## Context
The system is a modular monolith with **one Postgres instance, one schema per bounded context** (identity, volunteering, training, gamification, community, moderation, notifications, admin) and, critically, **no cross-schema foreign-key constraints** — cross-context references are by ID only, with integrity enforced at the application layer and via domain events. This is a deliberate DDD-aligned choice to keep bounded contexts genuinely decoupled at the schema level while still running as one deployable service (no network hop between "services").

That decoupling only works in practice if there is a reliable way for one bounded context to **tell** another that something happened, without either (a) reaching directly into another schema's tables (which would defeat the whole point of separate schemas) or (b) calling another module's code synchronously inside the same transaction in a way that couples their failure/availability together and their release cadence.

Concrete cross-context integration needs already implied by the domain:
- **Training → Gamification**: a volunteer completing a course (`training.course_completions`) should trigger a badge award and points in `gamification`, per research 01's finding that a tiered recognition ladder and portable badges are core to the design (comparable orgs: ASF's contribution ladder, Mozilla's Open Badges).
- **Volunteering → Gamification**: an approved hour-log entry (`volunteering.hour_entries`, research 05 checklist item 2: immutable-once-approved) should feed points/leaderboard updates.
- **Identity → Notifications**: a new person registering, or a role being granted/revoked (ADR-0007), should trigger a welcome/notification email without the `identity` module needing to know anything about email delivery mechanics.
- **Moderation → Community/Notifications**: an enforcement action (warn/mute/suspend/ban, research 05 §4) needs to propagate a UI-visible state change and a notification to the affected person.
- **Volunteering/Training → Admin**: events feed org-wide reporting/exports (research 05 checklist item 3) without the reporting module querying seven other schemas' internals directly.

The correctness requirement underlying all of these: **the state change and the fact that other modules were told about it must not go out of sync.** If a course-completion row commits but the "tell gamification" step is lost (crash, network blip, process restart), a volunteer silently never gets their badge — a real trust/engagement problem for a platform whose core value proposition is gamified recognition. Conversely, if the notification fires but the underlying transaction later rolls back, a person gets told about something that didn't actually happen.

The system is also explicitly **low-ops, small-team** (research 04): no dedicated infrastructure engineering to run and operate a message broker cluster, and the recommended stack explicitly favors staying on Postgres rather than adding a second stateful system.

## Decision
Use the **transactional outbox pattern**: every bounded-context schema that produces cross-context-relevant events has its own `domain_events` table, written **in the same database transaction** as the state change that caused the event — so the event's existence is exactly as durable and exactly as atomic as the state change itself, with no separate "did the notification succeed" failure mode to reconcile. A Postgres-native durable job runner, **graphile-worker**, polls/LISTENs for new rows across these outbox tables and delivers each event to the subscribing module(s), which process it (also transactionally, in their own schema) and mark it handled.

No message broker (Kafka, RabbitMQ, SQS/SNS, Redis Streams) is introduced for v1. Postgres is both the system of record and the event-delivery backbone.

### Outbox table schema (repeated per schema that produces events)

```sql
-- e.g. training.domain_events
CREATE TABLE training.domain_events (
  id             text PRIMARY KEY,               -- ULID (ADR-0005) — chronological by construction
  event_type     text NOT NULL,                  -- e.g. 'training.course_completed.v1'
  aggregate_type text NOT NULL,                  -- e.g. 'course_completion'
  aggregate_id   text NOT NULL,                  -- the ULID of the row that changed
  payload        jsonb NOT NULL,                 -- event-specific data, versioned by event_type suffix
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz NULL,                -- set once handed to graphile-worker
  processed_at   timestamptz NULL,                -- set once ALL subscribers confirm handling (see below)
  attempt_count  integer NOT NULL DEFAULT 0,
  last_error     text NULL
);

CREATE INDEX idx_training_domain_events_undispatched
  ON training.domain_events (id) WHERE dispatched_at IS NULL;
```

Each producing module writes to its own `domain_events` table as part of the same Prisma transaction that changes domain state:
```typescript
await db.$transaction(async (tx) => {
  const completion = await tx.courseCompletion.create({ data: { id: newId(), personId, courseId, completedAt: new Date() } });
  await tx.domainEvent.create({
    data: {
      id: newId(),
      eventType: "training.course_completed.v1",
      aggregateType: "course_completion",
      aggregateId: completion.id,
      payload: { personId, courseId, completedAt: completion.completedAt },
    },
  });
});
```

### Delivery via graphile-worker

A single, small **event-relay worker task** (one per producing schema, or one generic task parameterized by schema) runs on `graphile-worker`'s job queue — itself backed by Postgres (`graphile_worker.jobs`), consistent with "no second stateful system." The relay task:
1. Polls (`LISTEN`/`NOTIFY`-triggered, with a polling fallback) each schema's `domain_events` table for `dispatched_at IS NULL` rows, oldest first (ULID order — ADR-0005's sortability benefit realized directly here).
2. For each row, enqueues one `graphile-worker` job per interested subscriber module (a static subscription map — e.g., `training.course_completed.v1` → `["gamification", "notifications"]`), then stamps `dispatched_at`.
3. Each subscriber job handler runs the subscribing module's own transactional handling (e.g., `gamification`'s handler awards a badge and writes its own outbox event `gamification.badge_awarded.v1` if other modules need to react in turn) and reports success/failure to `graphile-worker`, which manages retries with exponential backoff on failure.
4. `processed_at` on the source event is stamped once all subscriber jobs for that event have succeeded (tracked via a small `domain_event_dispatches(event_id, subscriber, job_id, succeeded_at)` join table per producing schema), giving an auditable, queryable record of exactly which modules processed which event and when.

### Idempotency and retry guarantees

- **At-least-once delivery**: `graphile-worker` retries failed jobs; a subscriber handler *will* sometimes see the same event more than once (e.g., the handler succeeds but the "mark job complete" step crashes before committing that fact).
- **Idempotent handlers are mandatory**: every subscriber handler is written to be safe under redelivery — typically by having the handler itself write a `(event_id, subscriber_module)` uniqueness record inside its own transaction (e.g., `gamification.processed_events(event_id PRIMARY KEY, processed_at)`) and checking/inserting that record atomically with the domain effect (the badge award), so a redelivered event is a no-op the second time, detected and skipped inside the same transaction that would otherwise double-award.
- **Ordering**: guaranteed only *within* a single producing aggregate's event stream (ULID order per schema's outbox table), not globally across schemas — acceptable because subscribers key their idempotency and business logic off `aggregate_id`, not cross-schema interleaving order.
- **Poison-message handling**: after a configured max-attempt count, `graphile-worker` moves a job to a failed/dead state rather than retrying forever; `last_error` and `attempt_count` on the source event row make failed deliveries queryable for an admin/ops dashboard, and Sentry (canonical observability stack) alerts on jobs exceeding a retry threshold.

## Consequences

### Positive
- **Atomicity is free**: because the event row is written in the same transaction as the state change, there is no window where the state changed but the event didn't get recorded (or vice versa) — the classic "dual write" problem is structurally impossible here, without needing two-phase commit or a CDC (change-data-capture) pipeline.
- **No new infrastructure**: `graphile-worker` runs against the same Postgres instance already in use, satisfying the low-ops constraint (research 04) — one database to back up, monitor, and reason about failure modes for, not a database plus a broker cluster.
- **Auditable by default**: `domain_events` rows are themselves a durable, queryable log of "what happened and when" per bounded context — directly useful for debugging ("why didn't this volunteer get their badge") and indirectly supports the audit-trail requirements elsewhere in the system (ADR-0007) without extra plumbing.
- **Preserves true schema decoupling**: `gamification` never queries `training`'s tables directly (which the no-cross-schema-FK rule already forbids); it only ever reacts to `training.course_completed.v1` payloads, so `training`'s internal schema can change freely as long as the event contract is honored — exactly the loose coupling DDD bounded contexts are meant to have, achieved here without a network-based service boundary.
- **Cheap to reason about failure**: because everything lives in Postgres, a stuck or failed event is a normal SQL query away from being diagnosed (`SELECT * FROM training.domain_events WHERE processed_at IS NULL AND attempt_count > 3`), rather than requiring broker-specific tooling (Kafka consumer-lag dashboards, RabbitMQ management UI) the team would need to learn.

### Negative / Trade-offs
- **Polling/LISTEN latency, not true real-time streaming**: event delivery has a small delay (typically sub-second with `LISTEN`/`NOTIFY`, up to the polling interval as a fallback under connection issues) rather than the millisecond-scale push of a dedicated broker. Acceptable for badge awards, notifications, and reporting — none of these are latency-sensitive in the way, say, a trading system would be.
- **Throughput ceiling tied to Postgres**: `graphile-worker`'s job table and the outbox tables all live in the same Postgres instance that's also serving the application's primary read/write load. At very high event volume this could contend with primary workload. Accepted because the platform's realistic event volume (research 01: chapters of tens to low hundreds of active members, not millions of users) is far below where this becomes a real concern; monitored via Postgres query performance metrics (OpenTelemetry, canonical observability stack) with headroom to move the worker to a read replica or a separate connection pool before it's a problem.
- **No built-in cross-service fan-out**: because this is a monolith with one Postgres instance, the outbox pattern here is solving *intra-process, cross-schema* decoupling, not multi-service distributed messaging — if the system later splits into genuinely separate deployable services, this exact mechanism does not extend cleanly across a network boundary without additional work (see Alternatives / trigger conditions).
- **Handler idempotency is a discipline requirement, not automatically enforced**: every new subscriber handler must remember to implement the `processed_events` dedupe check; there's no framework-level guarantee forcing this. Mitigated by a shared `packages/outbox` helper that wraps handler registration and requires an idempotency-key check function as part of the handler's type signature, so omitting it is a type error, not just a missed convention.
- **Two-step "dispatched then processed" bookkeeping adds schema surface**: each producing schema needs its own `domain_events` table plus a dispatch-tracking table, and the relay task needs a static subscription map kept in sync with which modules actually care about which event types — a maintenance point that must be updated whenever a new event type or new subscriber relationship is introduced.

## Alternatives Considered

- **Kafka / RabbitMQ / SQS+SNS (dedicated message broker)**: rejected for v1. A dedicated broker is the right call at a scale or a service topology this system doesn't have yet: genuinely independent deployable services needing durable, high-throughput, multi-consumer-group pub/sub across a network boundary, run by a team with the operational capacity to manage broker infrastructure (clustering, partition rebalancing, consumer-group offset management). This system is one deployable Node/Next.js service talking to one Postgres instance, run by a small team with no dedicated infrastructure staff (research 04) — introducing Kafka/RabbitMQ/SQS would mean standing up and operating (or paying for a managed version of) a second stateful system for a workload Postgres comfortably handles at this scale, purely to future-proof for a service split that hasn't been decided on. **Trigger conditions to reconsider**: (1) the modular monolith is deliberately split into independently deployable services (a decision that would need its own ADR), at which point cross-service event delivery genuinely needs a network-native broker; (2) sustained event throughput or fan-out breadth measurably degrades primary Postgres workload despite read-replica/connection-pool mitigation; (3) a concrete requirement emerges for consumer patterns the outbox+graphile-worker model doesn't support well, such as long-term event replay for a new consumer joining months later, or multi-datacenter event distribution.
- **Synchronous in-process function calls between modules** (e.g., `training`'s course-completion handler directly calls `gamificationModule.awardBadge(...)` in the same request): rejected as the general integration mechanism — it would recouple bounded contexts at the code level (a `training` code change could break `gamification` at compile/runtime), make `training`'s request latency dependent on `gamification`'s (and `notifications`', and `admin`'s) internal logic succeeding, and complicate partial-failure handling (what happens if the course-completion write succeeds but the synchronous badge-award call throws — roll back the completion too?). Retained only for same-schema, same-aggregate operations where tight coupling is intentional and correct (e.g., within the `volunteering` schema itself), not across bounded-context boundaries.
- **Change Data Capture (CDC) via Postgres logical replication (e.g., Debezium) instead of an explicit outbox table**: a real alternative to hand-writing outbox rows — CDC tails the WAL and emits events for row changes without the application needing to write to a `domain_events` table explicitly. Rejected for v1 because it requires operating a CDC pipeline (Debezium + Kafka Connect, typically) which reintroduces the broker-operational-cost problem this ADR is specifically avoiding, and because explicit outbox writes give the application precise control over *event shape and versioning* (`training.course_completed.v1` payload contract) rather than events being a raw reflection of table row changes, which would leak internal schema structure across the bounded-context boundary the schemas are meant to protect.
- **Two-phase commit (XA transactions) across a state-change database and a separate message queue**: rejected — 2PC is notoriously operationally fragile (coordinator failure scenarios, poor support/performance in most modern message brokers and ORMs), and the entire point of the outbox pattern is to get the same atomicity guarantee 2PC promises without needing a distributed transaction coordinator at all, by keeping the event write inside the same, ordinary, single-database transaction as the state change.

## Implementation Notes

**Library**: [`graphile-worker`](https://github.com/graphile/worker) — a mature, Postgres-native job queue (`LISTEN`/`NOTIFY` for low-latency pickup, polling fallback, exponential backoff retries, job priorities, cron-style recurring jobs if needed elsewhere e.g. retention-policy sweeps from research 05 checklist item 6). Runs as a long-lived Node process (`npx graphile-worker`) separate from the Next.js request-serving process but part of the same deployable codebase/monorepo — consistent with "Node.js for background workers" in the canonical stack.

**Subscription map** (kept in one place, `packages/event-bus/src/subscriptions.ts`):
```typescript
export const subscriptions: Record<string, string[]> = {
  "training.course_completed.v1": ["gamification", "notifications"],
  "volunteering.hour_entry_approved.v1": ["gamification", "admin"],
  "identity.person_registered.v1": ["notifications"],
  "identity.role_granted.v1": ["notifications"],
  "moderation.enforcement_applied.v1": ["community", "notifications"],
  // ... one entry per event type, reviewed in PR whenever a new cross-context need arises
};
```

**Event naming/versioning convention**: `<schema>.<past_tense_fact>.v<N>` — e.g., `training.course_completed.v1`. A breaking payload-shape change ships as `.v2` with both versions handled by subscribers during a migration window, never a silent in-place payload change to `.v1`.

**Relay/dispatch job** (runs on a short interval, or triggered via `pg_notify` from a trigger on each `domain_events` table for near-real-time pickup):
```typescript
// apps/worker/src/tasks/relay-domain-events.ts
export async function relayDomainEvents(schemaName: string) {
  const undispatched = await getUndispatchedEvents(schemaName); // ORDER BY id (ULID) LIMIT 100
  for (const event of undispatched) {
    const subscribers = subscriptions[event.eventType] ?? [];
    for (const subscriber of subscribers) {
      await addJob(`handle-${subscriber}-event`, { eventId: event.id, schemaName, eventType: event.eventType, payload: event.payload });
    }
    await markDispatched(schemaName, event.id);
  }
}
```

**Idempotent handler contract** (shared helper every subscriber must use):
```typescript
export async function handleIdempotently(
  subscriberSchema: string, eventId: string, fn: (tx: PrismaTransaction) => Promise<void>
) {
  await db.$transaction(async (tx) => {
    const already = await tx.processedEvent.findUnique({ where: { eventId_subscriber: { eventId, subscriber: subscriberSchema } } });
    if (already) return; // no-op on redelivery
    await fn(tx);
    await tx.processedEvent.create({ data: { eventId, subscriber: subscriberSchema, processedAt: new Date() } });
  });
}
```

**Observability**: every `graphile-worker` job success/failure and every `domain_events` dispatch is instrumented with OpenTelemetry spans and reported to Sentry on failure (canonical observability stack), with an alert threshold on `attempt_count` approaching the max-retry ceiling so stuck event chains (e.g., a volunteer not receiving an earned badge) surface operationally before a support ticket does.
