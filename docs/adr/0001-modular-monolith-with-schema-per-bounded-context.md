# ADR-0001: Modular Monolith with One Postgres Schema per Bounded Context

## Status
Accepted — 2026-08-10

## Context
The Volunteer Portal serves the Agentics Foundation across eight cohesive domains identified in `docs/research/`: identity (person-centric profile with pluggable roles — see `05-domain-and-compliance.md` §"Day-One Checklist" item 1), volunteering (opportunities, shift sign-up, hour logging with an approval workflow that must produce immutable, grant-exportable records), training (video library, progress, quiz results — all treated as personal data under GDPR learning-analytics guidance), gamification (points/badges ledger, event-driven per `02-gamification-and-social.md`'s reference to the Oasis PBML model), community (feed, teams/guilds, scoped leaderboards), moderation (report/block/mute/suspend plus an append-only audit log, required "from day one" per the research), notifications, and admin.

The team is small, there is no dedicated ops staff, and the org is single-tenant (one Agentics Foundation instance, with Chapter as a scoping concept rather than a tenant boundary). `04-technical-architecture.md` explicitly recommends against adopting a microservices split "until scale demands it," favoring a low-ops managed stack (Vercel + managed Postgres). At the same time, the domain has real seams that must not be allowed to blur: hour-approval records must stay immutable once approved regardless of what the gamification ledger does with them; moderation's audit log must not be reachable by ad hoc joins from unrelated modules; consent/DSAR machinery in identity must be able to reason about "all data about a person" without every other module reaching directly into `identity` tables.

A single undifferentiated schema (one flat `public` schema, all tables) makes these seams invisible in the database — nothing stops a training-module query from joining straight into `gamification.points_ledger`, and over time ownership of tables becomes ambiguous, which is exactly the failure mode DDD bounded contexts exist to prevent. Full microservices (one deployable + one database per context) would solve the ownership problem but multiplies operational surface (8 services, 8 deploy pipelines, cross-service transactions, network calls where a function call would do) that this team and this traffic profile (a nonprofit volunteer base, not a hyperscale consumer app) does not justify.

## Decision
Build the Volunteer Portal as **one deployable Next.js/Node service** (a modular monolith), internally organized into modules that map 1:1 to the eight DDD bounded contexts: `identity`, `volunteering`, `training`, `gamification`, `community`, `moderation`, `notifications`, `admin`.

Each module owns its own **Postgres schema** in a single Postgres 15+ instance: `identity.*`, `volunteering.*`, `training.*`, `gamification.*`, `community.*`, `moderation.*`, `notifications.*`, `admin.*`. A module's tables live only in its own schema. **No foreign-key constraints cross schema boundaries.** Cross-context references (e.g., a `gamification.points_ledger` row referencing the volunteer who earned the points, or a `moderation.reports` row referencing the reported `community.post`) are stored as plain ID columns (ULID `text`, per ADR-0004) with no DB-level FK, no `ON DELETE CASCADE`, no cross-schema JOIN in application queries. Referential integrity across contexts is an application-layer and domain-event concern, not a database constraint — enforced by the transactional outbox (each schema has a `domain_events` table; see the cross-context integration decision in `04-technical-architecture.md` and the forthcoming outbox ADR) and by service-layer validation before writes.

Within a module, standard relational integrity (FKs, checks, unique constraints) is used freely — the "no cross-schema FK" rule applies only at bounded-context boundaries.

## Consequences

### Positive
- **Enforced ownership without deployment overhead.** Postgres schema boundaries make "which module owns this table" a database-level fact, not a convention people can silently violate — `moderation.report` (which carries evidence attachments and reporter identity) cannot be joined into a `training` query, so the compliance requirement that only screening/moderation admins reach that data is structurally supported, not just enforced by app-layer checks.
- **One deploy, one migration pipeline, one dashboard.** A two-to-five-person team ships one Next.js app to Vercel and runs one Postgres primary (Neon or Supabase). There is no service mesh, no distributed tracing across process boundaries to debug a single user request, no need to version an internal network API between "training service" and "gamification service."
- **Transactional consistency where it matters most.** Within a bounded context — e.g., writing an hour-approval record and its `domain_events` outbox row — both happen in a single Postgres transaction, which is exactly the consistency the immutable-hour-record requirement (`05-domain-and-compliance.md` item 2) needs. Cross-context effects (awarding points for an approved hour entry) are explicitly eventual-consistency via the outbox, matching the reality that "points reflect approved hours, slightly delayed" is an acceptable business rule.
- **Refactoring inside a context stays cheap.** Because module code and schema are colocated and owned by one team/PR, changing the internal shape of `training.*` (e.g., splitting `courses` into `courses` + `course_versions`) never requires coordinating a migration across services.
- **Documented extraction path exists without paying for it now** (see below), so the choice is reversible if a specific context (most plausibly `training`, if video-analytics workloads grow large, or `notifications`, if delivery volume spikes) needs independent scaling later.

### Negative / Trade-offs
- **No DB-enforced cross-context integrity.** A bug that writes a `gamification.points_ledger` row referencing a deleted `identity.person` is possible in a way it wouldn't be with a cross-schema FK; this must be caught by application tests, outbox-consumer validation, and periodic integrity-check jobs rather than by Postgres itself.
- **Single point of resource contention.** All eight modules share one Postgres instance's CPU/IO/connection pool. A runaway query in `community` (e.g., an inefficient leaderboard aggregation) can degrade `volunteering`'s hour-approval latency. Mitigated with per-module query budgets, connection pooling (PgBouncer/Neon pooler), and Postgres-level statement timeouts, but this is a real coupling microservices would avoid.
- **Discipline-dependent boundary.** Nothing at the infrastructure level stops a developer from importing another module's Prisma client and querying its schema directly in application code (Postgres schemas restrict SQL joins across roles/permissions only if grants are configured that way — see Implementation Notes). The boundary must be enforced by code review, lint rules, and Prisma client scoping, not assumed to be automatic.
- **One deploy means one blast radius.** A bad migration or a memory leak in the `training` module can take down `volunteering`'s hour-logging flow because they're the same process. This is accepted as a reasonable trade for the team's current size and is the primary reason the extraction path below is documented, not deferred indefinitely.

## Alternatives Considered
- **Microservices (one deployable + one database per bounded context).** Rejected for v1: eight services means eight CI/CD pipelines, eight sets of environment secrets, distributed transactions or sagas for any cross-context workflow (e.g., "approve hours → award points → post activity-feed item → send notification" would require a distributed saga instead of one transaction + outbox), and meaningfully more AWS/Vercel/observability spend and on-call complexity than a nonprofit with no dedicated ops team can support. `04-technical-architecture.md` explicitly recommends against this until scale demands it.
- **Single undifferentiated Postgres schema (`public`) for all tables.** Rejected: this is what most "modular monolith" projects default to and then regret — table ownership erodes within 6–12 months as any module can join any table, the moderation audit log (a compliance-sensitive, append-only log) would have no structural isolation from feature tables, and a later split into separate schemas or services becomes a large, risky migration instead of a boundary that was correct from day one.
- **Domain-driven "package by feature" in one schema, enforced only by folder structure/lint rules (no DB schema separation).** Considered as a lighter-weight middle ground. Rejected because Postgres `search_path` and schema-qualified table names give a durable, tool-agnostic (not editor/lint-dependent) enforcement mechanism that survives a change of linter, a rushed hotfix, or a new hire unfamiliar with the folder convention — and because it directly enables the eventual extraction path (a schema can become a separate database with `pg_dump --schema`; a folder cannot).
- **Full microservices with a shared database (schemas per service, but each service also directly reads other services' schemas).** Rejected as the worst of both worlds: all the deployment/ops overhead of separate services with none of the isolation benefit, since services would still be tightly coupled through direct cross-schema reads.

## Implementation Notes

### Folder structure
```
/src
  /modules
    /identity
      /domain          # entities, value objects, domain events (pure TS, no framework deps)
      /application      # use cases / command handlers, calls into policy module for `can()`
      /infra
        /prisma          # this module's slice of the Prisma schema (see ADR-0004) + repositories
      /api
        /trpc            # trpc routers exposed to the Next.js app (see ADR-0003)
        /rest             # REST resource handlers mounted under /api/v1/*, if this module has any
      index.ts           # the ONLY file other modules may import from (public module interface)
    /volunteering
    /training
    /gamification
    /community
    /moderation
    /notifications
    /admin
  /platform
    /outbox              # graphile-worker setup, outbox drain, event bus abstraction
    /policy               # can(subject, action, resource) — RBAC enforcement, shared by all modules
    /db                    # single PrismaClient instance, schema-qualified
```

### Enforcing the boundary in code
- Each module exports a single `index.ts` (its public interface: application-layer use cases and typed domain events). ESLint `no-restricted-imports` (or `import/no-internal-modules`) blocks any import of `modules/<x>/domain/**`, `modules/<x>/infra/**`, or `modules/<x>/application/**` from outside `modules/<x>/**`. Only `modules/<x>/index.ts` is importable cross-module, and even that should be used sparingly — prefer domain events over direct calls for anything that isn't a synchronous read needed for the current request (e.g., `identity` exposing a `getPersonSummary(id)` read used by `community` to render a feed author).
- A lightweight CI check (`scripts/check-module-boundaries.ts`, run in the `lint` CI stage) parses the Prisma schema and fails the build if any model in schema `training` has a `@relation` pointing at a model in another schema — this is the automated backstop for "no cross-schema FKs."

### Postgres schema setup
```sql
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS volunteering;
CREATE SCHEMA IF NOT EXISTS training;
CREATE SCHEMA IF NOT EXISTS gamification;
CREATE SCHEMA IF NOT EXISTS community;
CREATE SCHEMA IF NOT EXISTS moderation;
CREATE SCHEMA IF NOT EXISTS notifications;
CREATE SCHEMA IF NOT EXISTS admin;
```
Each schema gets its own Postgres role with grants limited to that schema for defense-in-depth (`GRANT USAGE, SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA training TO app_training;`), even though the Next.js app itself connects as a single pooled role in v1 — this makes a later "give the training module its own DB connection/instance" migration a config change, not a rewrite.

### Cross-context reference example (no FK)
```prisma
// schema: gamification
model PointsLedgerEntry {
  id          String   @id @default(cuid()) // ULID generated app-side, see ADR-0004
  personId    String   // references identity.Person.id — NO @relation, plain column
  sourceType  String   // "hour_approval" | "training_completion" | ...
  sourceId    String   // references e.g. volunteering.HourEntry.id — plain column
  points      Int
  createdAt   DateTime @default(now())

  @@schema("gamification")
  @@index([personId])
}
```
Integrity for `personId` is enforced by: (a) the write path only ever runs inside an outbox-consumer handler that received a validated `HourEntryApproved` domain event carrying a known `personId`; (b) a nightly integrity-check job (`scripts/jobs/check-orphaned-refs.ts`) that flags (not cascades on) orphaned cross-context IDs for manual review.

### Extraction path (documented, not built)
If a specific context later needs independent scaling (most likely candidates: `training` under heavy video-analytics write load, or `notifications` under high fan-out volume), the path is:
1. The schema is already isolated — `pg_dump --schema=training` produces a clean logical boundary.
2. Because the module already only communicates externally via its `index.ts` interface and domain events on its own `domain_events` outbox table, converting that interface from an in-process function call to an HTTP/tRPC-over-network call or a message-queue subscription is a mechanical change at the call sites, not a redesign.
3. Stand up the extracted service with its own database (migrated from the `training` schema), point the outbox worker at a real queue (e.g., promote from graphile-worker's Postgres-native queue to a hosted queue if throughput demands it), and cut the in-process import over to a network client behind the same `index.ts`-shaped interface.
4. No other module needs to change, because they never depended on `training`'s internals — only on its published interface and its published domain events.
