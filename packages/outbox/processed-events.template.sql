-- Ledger table template for @volunteer-portal/outbox's drainOutbox().
--
-- drainOutbox() does not create this table itself — this package has no
-- schema of its own to own it in (ADR-0001: every schema owns its own
-- tables; this package is called *from* a schema's code, e.g. a
-- graphile-worker task, not the other way round). Copy this into your
-- bounded context's own Prisma migration, once per schema that drains an
-- outbox with drainOutbox(), replacing <schema>. See the package README
-- for the full worked example and apps/web/prisma/schema.prisma's
-- `admin.audit_log` comment for the hand-authored-DDL precedent (Prisma's
-- schema language has no issue modeling this table's *columns* — add a
-- matching `model` there too, mapped with `@@map("processed_events")` /
-- `@@schema("<schema>")` — this .sql file exists only so the exact DDL,
-- including the composite primary key, is copy-pasteable in one piece).
create table "<schema>".processed_events (
  -- Identifies the consumer that processed the event — required because
  -- more than one independent consumer may drain the same
  -- `domain_events` table (real multi-subscriber fan-out); each needs its
  -- own "have I handled this event" bit. Pass the same value as
  -- `drainOutbox({ consumerName: ... })`.
  consumer      text not null,
  -- The source `domain_events.id` (a ULID) this consumer has handled.
  event_id      text not null,
  processed_at  timestamptz not null default now(),
  primary key (consumer, event_id)
);
