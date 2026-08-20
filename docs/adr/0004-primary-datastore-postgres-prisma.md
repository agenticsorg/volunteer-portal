# ADR-0004: Single Managed Postgres Instance with Prisma Multi-Schema Mode

## Status
Accepted — 2026-08-10

## Context
ADR-0001 establishes eight bounded-context Postgres schemas within one database, with no cross-schema foreign keys. That decision needs a concrete data-access layer that (a) understands multi-schema Postgres, (b) can express per-module models without letting modules leak into each other's migrations, and (c) supports the domain's specific data shapes: an immutable-once-approved hour-entry ledger (`05-domain-and-compliance.md`), a points/badges event ledger (`02-gamification-and-social.md`'s Oasis-style event log → ledger → rules-engine pattern), a `domain_events` outbox table per schema (ADR-0001's cross-context integration mechanism), consent records with versioned policy text and per-purpose flags, and an append-only moderation audit log.

`04-technical-architecture.md` recommends "managed Postgres (Supabase or Neon)... relational integrity for points/badges/hours ledgers" and explicitly steers away from a second data store for search (`pgvector` on the primary Postgres, not a separate vector DB like RuVector — see that document's assessment that RuVector is "young... Rust-native... integration overhead for a small team," appropriate to revisit only if semantic search becomes a real pain point post-MVP). The research also never proposes splitting data across multiple database technologies (e.g., a document store for the feed, a separate time-series DB for video analytics) — every data shape identified (ledgers, audit logs, consent records, course progress) is naturally relational with clear ownership, and the team is small enough that operating N different datastore technologies is a real cost with no offsetting benefit at this stage.

Primary keys need to be assignable before insert (so a `domain_events` outbox row can reference the just-created entity's ID within the same transaction, and so IDs can be generated in application code without a DB round-trip), sortable by creation time (useful for the feed, the audit log, and the outbox drain order), and safe to expose in URLs — which is why ULIDs, not auto-increment integers or raw UUIDv4, are the canonical ID choice.

## Decision
**One managed Postgres 15+ instance** (Neon or Supabase, per the canonical hosting decision) is the sole primary datastore for the Volunteer Portal in v1 — no secondary database, no polyglot persistence. Full-text search uses Postgres's built-in `tsvector`/`tsquery`; `pgvector` is the documented phase-2 path if semantic search (matching volunteers to opportunities by free-text skill descriptions, or searching training-video transcripts) becomes a real need, added as an extension on this same instance, not a new service.

**Prisma in multi-schema mode** (`previewFeatures = ["multiSchema"]`, stable since Prisma 5.15+, GA in Prisma 6) is the ORM and migration tool. One `schema.prisma` file (or Prisma's multi-file schema support, `prismaSchemaFolder`) declares all models across all eight schemas, with every model tagged `@@schema("...")` matching its owning bounded context from ADR-0001. Cross-schema relations are never declared as Prisma `@relation` fields — a cross-context reference is a plain scalar column (e.g., `personId String`), matching ADR-0001's "no cross-schema FK" rule at the ORM level, not just the DB level.

**Primary keys are ULIDs** (26-character, Crockford base32, lexicographically sortable by creation time, URL-safe), generated **application-side** (not by a Postgres default/extension) via the `ulid` npm package, stored as Postgres `text` columns (not a custom Postgres domain type, not `uuid` — plain `text` avoids any driver-level UUID-format validation friction and keeps the type trivially portable).

**Migrations** are managed with `prisma migrate dev` locally and `prisma migrate deploy` in CI/CD, one linear migration history for the whole database (Prisma does not support independent per-schema migration histories within one `schema.prisma`), with a migration-dry-run gate in GitHub Actions (per the canonical CI/CD decision) that runs `prisma migrate diff` against a shadow database before merge.

## Consequences

### Positive
- **One connection pool, one backup/restore story, one place to reason about transactions.** A single managed instance means point-in-time recovery, connection pooling (via Neon's or Supabase's built-in pooler, or PgBouncer), and monitoring are configured once — critical for a team without dedicated database ops.
- **True ACID transactions for the outbox pattern.** Because every schema lives in the same physical database, writing a domain state change and its corresponding `domain_events` outbox row happens in a single Postgres transaction (`BEGIN; INSERT INTO volunteering.hour_entries ...; INSERT INTO volunteering.domain_events ...; COMMIT;`) — this is the mechanism that makes the outbox pattern reliable (no dual-write problem) and it is only free because there is one database, not eight.
- **Prisma's multi-schema mode gives per-module model ownership with one generated client.** Each module's `application`/`infra` layer imports the same `PrismaClient` but only ever touches models tagged with its own `@@schema`, which is enforced by the module-boundary lint rule from ADR-0001 (a module importing another schema's Prisma model is a lint error, not just a style violation).
- **ULIDs solve three problems at once with one ID scheme.** (1) Application-generated, so a use case can construct a fully-formed entity — including its ID — before any DB call, letting it build the outbox event in the same object graph as the entity, no "insert then re-fetch ID" round trip; (2) sortable by creation time, so `ORDER BY id` on `admin.audit_log` or `gamification.domain_events` gives correct chronological order without a separate `created_at` index for that purpose (though `created_at` is still kept for human-readable timestamps); (3) opaque and URL-safe, avoiding the enumeration risk of auto-increment integers on e.g. `/certificates/{id}` public links.
- **`tsvector` full-text search ships in v1 with zero new infrastructure.** Training-content and opportunity search work immediately using `GENERATED ALWAYS AS (to_tsvector(...)) STORED` columns and GIN indexes — no separate search service (Elasticsearch/Algolia/RuVector) to operate, monitor, or keep in sync via CDC.
- **Extraction and phase-2 paths stay open without complicating v1.** `pgvector` can be `CREATE EXTENSION`'d on this same instance later with zero migration of existing data; a bounded context's schema can be `pg_dump`'d out to its own instance later per ADR-0001's extraction path — neither requires re-platforming away from Postgres.

### Negative / Trade-offs
- **One migration history for eight schemas means coordination on merge.** Two modules' migrations landing in the same PR window can conflict at the Prisma migration-file level even though their schemas are logically independent; mitigated by keeping migrations small and module-scoped, and by the CI dry-run gate catching conflicts before merge rather than at deploy time.
- **No independent scaling per bounded context.** All eight schemas share the instance's compute/IO/connection budget (the same trade-off noted in ADR-0001) — a `training` schema under heavy video-analytics write load competes for resources with `volunteering`'s hour-approval writes. Mitigated with Postgres statement timeouts per role and read replicas for read-heavy modules (leaderboard, feed) if needed before a full extraction is warranted.
- **Prisma multi-schema mode has rough edges.** Cross-schema raw SQL (e.g., an admin reporting query that legitimately needs to join across schemas for a one-off export, which is allowed at the SQL level even though the ORM/app code forbids cross-schema *relations*) must use `prisma.$queryRaw`, bypassing Prisma's type safety for that query — accepted as a deliberate escape hatch for genuinely cross-cutting admin/reporting needs, not a backdoor for feature code.
- **ULIDs are not a native Postgres type.** Stored as `text`, they get no automatic `uuid`-column validation, sort correctly only because of their encoding (not enforced by the column type), and are marginally larger on disk/index than a native `uuid` (26 bytes as text vs. 16 bytes binary for `uuid`) — accepted given the generation-order and application-side-construction benefits above outweigh the storage cost at this data scale (a nonprofit volunteer base, not billions of rows).
- **`prisma migrate deploy` applies to the whole database atomically per migration file** — there is no per-schema partial rollback; a bad migration touching `training` in the same deploy as an unrelated `identity` change means both are rolled back together if either fails. Mitigated by the one-PR-one-module convention from ADR-0001's ownership model, keeping most migrations single-schema in practice even though the tool doesn't enforce it.

## Alternatives Considered
- **Polyglot persistence** — e.g., Postgres for ledgers/identity, MongoDB or a document store for the feed/community content, a dedicated time-series DB (TimescaleDB/InfluxDB) for video-watch analytics, Redis for leaderboards. Rejected for v1: every data shape identified in the research (hour ledger, points ledger, feed posts, course progress, consent records, audit log) is relational with clear referential shape and moderate volume — none of it demonstrates the write-throughput or query-pattern pressure that would justify operating 2–4 additional datastore technologies with a small team and no dedicated ops function. Postgres's `JSONB` columns absorb the semi-structured cases (e.g., flexible per-course quiz-result payloads) without needing a document store, and window functions/materialized views absorb leaderboard aggregation without needing Redis sorted sets at this scale.
- **RuVector (ruvnet's embedded Rust vector DB) for search/matching.** Explicitly considered and rejected per `04-technical-architecture.md`'s own assessment: legitimate technology (4.4k★, HNSW, SIMD) but young, Rust-native (real integration friction for a TypeScript-only team per the canonical stack), and this is "a very-early-stage need for an MVP." `pgvector` on the existing Postgres instance is the lower-risk phase-2 path if semantic search is ever needed, avoiding a second datastore entirely.
- **Drizzle ORM instead of Prisma.** A real, lighter-weight, SQL-closer alternative with good TypeScript inference. Rejected in favor of Prisma specifically for multi-schema mode's maturity (Prisma shipped and stabilized `multiSchema` explicitly for this modular-monolith-with-schemas pattern; Drizzle's schema-per-file conventions can express multiple Postgres schemas but with less mature first-class tooling around it as of this decision) and for Prisma Migrate's more opinionated, batteries-included migration workflow, which matters more than Drizzle's lower query-building overhead for a team that needs the CI migration-dry-run gate to be a well-trodden path (`prisma migrate diff --shadow-database-url`) rather than something assembled from lower-level primitives.
- **Auto-increment integers (`bigserial`) or raw UUIDv4 as primary keys.** `bigserial` rejected: requires a DB round-trip before the ID is known, which breaks the "construct entity + outbox event together, then commit" pattern the outbox relies on, and leaks sequential volume information through public URLs (certificate IDs, opportunity IDs). UUIDv4 rejected: solves the application-side-generation and enumeration concerns but is not sortable by creation time, which matters for `ORDER BY id` correctness on the audit log and outbox drain, and is visually/lexically worse for debugging (no embedded timestamp) than ULID.

## Implementation Notes

### Prisma schema shape
```prisma
// prisma/schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["identity", "volunteering", "training", "gamification", "community", "moderation", "notifications", "admin"]
}

model Person {
  id        String   @id            // ULID, set by application code, not @default(cuid())
  email     String   @unique
  createdAt DateTime @default(now())
  // ...
  @@schema("identity")
}

model HourEntry {
  id           String    @id
  personId     String              // cross-context ref to identity.Person — plain column, no @relation
  opportunityId String
  status       HourEntryStatus @default(SUBMITTED)
  startAt      DateTime
  endAt        DateTime
  approverId   String?
  approvedAt   DateTime?
  rejectionReason String?
  createdAt    DateTime  @default(now())

  @@schema("volunteering")
  @@index([personId, status])
}

enum HourEntryStatus {
  SUBMITTED
  APPROVED
  REJECTED
  @@schema("volunteering")
}

model DomainEvent {
  id          String   @id
  aggregateId String
  eventType   String
  payload     Json
  occurredAt  DateTime @default(now())
  processedAt DateTime?

  @@schema("volunteering")   // one DomainEvent model per schema, same shape, repeated per bounded context
  @@index([processedAt])
}
```
Each of the eight schemas gets its own `DomainEvent` (or `domain_events` table) with an identical shape, drained by graphile-worker per ADR-0001.

### ID generation
```ts
// src/platform/id.ts
import { ulid } from "ulid";
export const newId = () => ulid(); // e.g. "01J6ZQK8N3XG7V9T2E4R6WYABC"
```
Every module's application-layer "create" use case calls `newId()` before constructing the entity, e.g.:
```ts
const hourEntry = { id: newId(), personId, opportunityId, status: "SUBMITTED" as const, startAt, endAt };
await prisma.$transaction([
  prisma.hourEntry.create({ data: hourEntry }),
  prisma.domainEvent.create({ data: { id: newId(), aggregateId: hourEntry.id, eventType: "HourEntrySubmitted", payload: hourEntry } }),
]);
```

### Migration workflow
- Local: `prisma migrate dev --name <module>_<change>` (naming convention: `volunteering_add_rejection_reason`, prefixed by schema to make cross-module conflicts visible in migration filenames).
- CI (GitHub Actions, per canonical CI/CD gate): `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url $SHADOW_DB_URL --exit-code` fails the build if the checked-in migrations don't match the schema (dry-run gate).
- Deploy: `prisma migrate deploy` runs as a pre-boot step in the deploy pipeline (Vercel build step or a dedicated GitHub Actions job gating the Vercel deploy), never `migrate dev` or `db push` outside local development.

### Full-text search (v1)
```sql
ALTER TABLE training.courses
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))) STORED;
CREATE INDEX courses_search_idx ON training.courses USING GIN (search_vector);
```
Queried via `prisma.$queryRaw` (the documented cross-cutting-query escape hatch) since Prisma has no first-class `tsvector` query builder.

### Phase-2 path (pgvector, not built now)
`CREATE EXTENSION IF NOT EXISTS vector;` on the same instance, an `embedding vector(1536)` column added to the relevant schema's table via a normal Prisma migration (Prisma treats it as `Unsupported("vector(1536)")`), populated via a background job calling an embeddings API — no new datastore, no RuVector, no separate vector service.
