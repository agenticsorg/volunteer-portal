# ADR-0005: Identifier Strategy — ULIDs Everywhere

## Status
Accepted — 2026-08-10

## Context
The portal is a modular monolith (ADR-0002, implied by the canonical architecture) with one Postgres instance holding a separate schema per bounded context (identity, volunteering, training, gamification, community, moderation, notifications, admin). Cross-context references are **by ID only** — there are no cross-schema foreign keys, so referential integrity between e.g. a `volunteering.hour_entries` row and an `identity.persons` row is enforced entirely at the application layer and via domain events (outbox pattern, ADR-0009).

This puts unusual weight on the identifier itself:

- **IDs must be safe to pass across schema boundaries without a database round-trip to "reserve" them.** A domain-event payload (e.g. `Training.CourseCompletedEvent`) carries the learner's person ID and the course ID as plain strings that another schema's module will later look up. If IDs were DB-generated serials scoped per-table, there is no risk of collision, but there is a risk of *meaning leakage* (see below) and of write-order coupling (the row must exist before the ID is known, which complicates outbox-event construction that wants the ID before commit in some flows).
- **IDs appear in URLs.** Public opportunity listings, training video pages, and chapter pages are server-rendered (Next.js App Router) and SEO-relevant per the domain research; volunteer-facing profile and badge pages are shared/linked socially per the "portable, shareable badges" finding (research 01, comparables §Mozilla Open Badges). Sequential integer IDs in a URL (`/opportunities/4821`) leak business volume (how many opportunities exist, growth rate) and are trivially enumerable, which is a real concern for a public-facing volunteer/donor platform with PII-adjacent records (research 05, GDPR section — volunteer records are personal data).
- **Sorting by creation time is a constant, recurring need.** Activity feeds, leaderboards' underlying event logs, moderation audit logs, and the outbox `domain_events` table (ADR-0009) all want chronological ordering. A random UUIDv4 primary key forces a separate `created_at` index for anything that wants "recent N" queries, and defeats natural clustering in Postgres's default btree PK index, causing index bloat and worse cache locality on the hot `domain_events` and `hour_entries` tables under write load.
- **IDs are generated in TypeScript application code**, not by the database, because: (a) the outbox pattern needs the event's ID to exist before the transaction commits in some producer code paths (e.g. optimistic UI, idempotency keys sent to `graphile-worker`), and (b) Prisma multi-schema mode (canonical ORM decision) works more predictably when every model has an explicit, application-supplied `id` default rather than mixing DB `gen_random_uuid()` defaults across 8+ schemas.

## Decision
Use **ULIDs** (Universally Unique Lexicographically Sortable Identifiers, per the [ulid spec](https://github.com/ulid/spec)) as the primary key for every table in every bounded-context schema, with no exceptions for join/junction tables or event-log tables.

- 26-character, Crockford Base32-encoded, case-insensitive-safe strings.
- First 48 bits: millisecond Unix timestamp → IDs sort lexicographically by creation time.
- Remaining 80 bits: cryptographically secure randomness → collision probability is negligible at this system's scale (a nonprofit volunteer platform, not a global-scale consumer app) and monotonicity within the same millisecond is enforced by the chosen library (see below).
- Generated **application-side**, in TypeScript, before the row is inserted — never via a Postgres default (`gen_random_uuid()`, `nextval()`, etc.) and never via a database trigger.
- Stored as Postgres `text` (not a custom domain type, not `uuid`), per the canonical decision. `text` avoids the type-cast friction UUID columns cause when a ULID needs to travel through a JSON event payload, a URL parameter, or a `graphile-worker` job payload without an explicit cast.
- Validated at every API boundary (tRPC input schemas and the public `/api/v1/*` REST layer) with a strict Zod regex/format check before ever reaching a query — untrusted ULID-shaped strings from the outside world are never trusted as "this row exists," only as "this is shaped like an ID we might look up."

## Consequences

### Positive
- **Lexicographic sortability**: `ORDER BY id` and `ORDER BY created_at` produce identical results, so hot paths (activity feed, moderation log, outbox drain query `WHERE processed_at IS NULL ORDER BY id LIMIT 100`) can rely on the PK index directly without a composite `(created_at, id)` index.
- **Postgres index locality**: because new IDs are monotonically increasing (millisecond-prefixed), btree PK inserts are append-mostly at the right edge of the index, avoiding the random-page-write amplification UUIDv4 causes on high-write tables like `domain_events` and `hour_entries`.
- **URL/leak-resistance**: unlike auto-increment integers, a ULID reveals no information about total row count or growth rate; unlike UUIDv4, it does leak approximate creation time (see trade-off below), which is an acceptable, bounded disclosure for a volunteer platform (not a security-sensitive fact for this domain).
- **No coordination required**: any of the 8 bounded-context modules, background workers, or the public REST layer can mint IDs independently with no DB round-trip, no auto-increment sequence contention, and no risk of cross-schema collision — essential given the "no cross-schema FK, integrity via app layer + events" architecture, where an event producer must be able to construct a fully-formed event payload (including the new entity's ID) before the transaction that persists it commits.
- **Consistent with ORM**: Prisma's `@default(dbgenerated(...))` is avoided entirely; every model instead uses `@default(cuid())`-style app-side generation swapped for a ULID factory, keeping ID generation logic in one shared package (`packages/shared/src/ulid.ts`) rather than scattered across 8 schema `.prisma` files with inconsistent defaults.

### Negative / Trade-offs
- **Timestamp disclosure**: a ULID reveals its creation time (millisecond precision) to anyone who can decode Base32 — trivial. For most entities (opportunities, courses, badges) this is a non-issue. For `identity.persons` specifically, this means "when did this person's account row get created" is technically inferable from their ID if it ever leaks into a public context. Mitigation: person-facing public IDs (profile URLs) use a separate, non-ULID public slug (see Implementation Notes) rather than exposing the internal `persons.id` directly.
- **Not a database-native type**: Postgres has no native ULID column type (unlike `uuid`), so there is no DB-level format validation, no `gen_random_uuid()`-equivalent convenience default, and no specialized index type — `text` with a btree index performs well here but has a slightly larger on-disk footprint (26 bytes + varlena overhead) than a native 16-byte `uuid` column. Accepted trade-off given the sortability and cross-schema-friendliness win.
- **Requires discipline at every insert site**: because generation is app-side, every Prisma `create()` call across every module must remember to supply an `id` — there is no DB fallback. Mitigated by a shared Prisma middleware / helper (see Implementation Notes) rather than relying on developers remembering.
- **Library dependency risk**: correctness of monotonicity-within-a-millisecond and CSPRNG usage rests on a third-party npm package, not Postgres internals. Mitigated by pinning a well-maintained library and covering it with a contract test.

## Alternatives Considered

- **UUIDv4** (random 128-bit, RFC 4122): the incumbent default for "collision-resistant, no coordination" IDs. Rejected as the primary key because pure randomness destroys insert locality (index bloat, worse cache hit rate on `domain_events` under sustained outbox-drain load) and because UUIDv4 has zero natural sort order, forcing a separate `created_at` index everywhere chronological listing is needed (activity feeds, moderation logs, leaderboards' backing event tables) — an extra index per table across 8 schemas for no benefit ULIDs don't already provide. UUIDv4 remains an acceptable choice for one-off non-PK values (e.g., a CSRF token, an API key secret) where sortability is irrelevant.
- **UUIDv7** (time-ordered UUID, RFC 9562, finalized 2024): the closest real competitor — also millisecond-prefixed and sortable, and it fits natively in Postgres's `uuid` column type. Rejected in favor of ULID for three concrete reasons: (1) ULID's Crockford Base32 string form is shorter and URL-safe without encoding (no `-` characters to strip/keep-consistent, case-insensitive), which matters because IDs are directly exposed in public URLs (opportunity pages, badge pages) per the SEO/shareability requirement in research 04; (2) the project's canonical decision already specifies ULIDs stored as `text`, established before this ADR, for consistency across the whole system rather than re-litigating per table; (3) the TypeScript ULID ecosystem (the `ulid` package, `ulidx`) is mature and simple, while UUIDv7 npm support was comparatively newer at the time this stack was chosen. UUIDv7 is the fallback if a future audit finds the `text` storage overhead genuinely material at scale.
- **Auto-increment integers (`serial`/`bigserial`)**: rejected outright — sequential, trivially enumerable (a competitor or bad actor can estimate total volunteers, opportunities, or donations by ID gaps), require a DB round-trip to obtain before the row exists (incompatible with constructing event payloads pre-commit), and cannot be generated by two different bounded-context modules without a shared sequence, which contradicts the explicit "no cross-schema coupling" architecture.
- **Composite/natural keys** (e.g., `(chapter_id, email)` for a person): rejected for primary keys — natural keys change (email changes, chapter reassignment), and composite keys propagate through every foreign-key-by-convention reference across 8 schemas, multiplying event-payload complexity. Retained only as unique constraints where genuinely useful (e.g., `(person_id, badge_id)` uniqueness on an award table).

## Implementation Notes

**Library**: [`ulid`](https://www.npmjs.com/package/ulid) (or `ulidx` if Edge-runtime compatibility with Next.js middleware/edge functions is needed — verify at implementation time since Next.js middleware runs on the Edge runtime and some crypto APIs differ from Node). Pin an exact version in `package.json`; do not use a caret range for an identity-critical dependency.

**Shared factory** — one place, reused by every schema:
```typescript
// packages/shared/src/id.ts
import { ulid } from "ulid";

export type EntityId = string; // branded types optional; see below

export function newId(): EntityId {
  return ulid(); // monotonic within-process via library's internal clock guard
}

// Optional: branded type per entity for compile-time misuse prevention
export type PersonId = string & { readonly __brand: "PersonId" };
export const newPersonId = (): PersonId => ulid() as PersonId;
```

**Prisma schema convention** (repeated per model, every schema):
```prisma
model Person {
  id        String   @id @db.Text
  // ... other fields
  @@schema("identity")
}
```
No `@default(...)` on `id` — the application always supplies it explicitly via `newId()` at `create()` time, enforced by a lint rule / code-review checklist item ("every `prisma.<model>.create` call must pass `id`") and, where feasible, a thin repository-layer wrapper that generates the ID so callers cannot forget:
```typescript
async function createPerson(data: Omit<Person, "id">): Promise<Person> {
  return db.person.create({ data: { id: newId(), ...data } });
}
```

**API-boundary validation** (tRPC + REST):
```typescript
import { z } from "zod";

export const ulidSchema = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, "Invalid ULID format");

// tRPC procedure input
export const getOpportunityInput = z.object({ id: ulidSchema });
```
A ULID-shaped string passing this check is **not** proof the row exists — it only permits the string past input validation; the subsequent DB lookup still enforces existence and authorization via the `can(subject, action, resource)` policy module (ADR-0007).

**Public-facing slugs, not raw IDs, for person profiles**: `identity.persons` rows get a separate `public_slug text unique` column (e.g., a short random Base32 string or a chosen vanity handle) used in profile/badge URLs instead of `persons.id`, to avoid disclosing account-creation timestamps for people specifically (see Negative trade-offs above). Non-person entities (opportunities, courses, chapters, badges) expose their ULID directly in URLs — the timestamp disclosure is immaterial for those.

**Outbox event payloads** (ADR-0009 dependency): every `domain_events` row's `id` is itself a ULID, generated at event-construction time in the same transaction as the state change, giving the outbox table itself natural chronological ordering for the `graphile-worker` drain query without needing a secondary index.
