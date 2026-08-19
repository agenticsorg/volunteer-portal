# ADR 0004: ORM and Row-Level Security Enforcement — SQLx + `SET LOCAL`

## Status

Accepted — 2026-08-19

## Context

Following [[0003-database-provider]]'s choice of Neon over Supabase, role-
scoped access control cannot rely on Supabase-style JWT-claim RLS
policies. It must be enforced through a combination of the Rust data
access layer and native Postgres Row-Level Security, driven from
application code.

Two Rust data-access options exist: a full ORM (e.g. SeaORM, Diesel) or a
raw-SQL query layer with compile-time checking (SQLx). The research pass
recommends SQLx.

## Decision

Use **SQLx** — raw SQL with compile-time query verification via the
`query!`/`query_as!` macros, and an offline `.sqlx` query cache checked
into the repo so CI can verify queries against the schema without a live
database connection during the build step (a live Neon branch, per
[[0003-database-provider]], is still used for integration tests).

**Row-Level Security pattern:** every request-scoped database transaction
begins by executing:

```sql
SET LOCAL app.current_user_id = $1;
```

inside the *same transaction* as the scoped query that follows. Postgres
RLS policies on `volunteer`, `project`, `assignment`, `hour_entry`, and
`audit_log` reference `current_setting('app.current_user_id')` to scope
rows (e.g. a lead only sees `hour_entry` rows for projects where
`project.lead_id = current_setting('app.current_user_id')::uuid`, or
where they appear in `project_lead` per [[0005-audit-log-and-co-leads]]).

Two non-negotiable implementation requirements, both drawn directly from
the research pass:

1. **Must be `SET LOCAL`, never plain `SET`.** If the app ever sits
   behind PgBouncer in transaction-pooling mode (a plausible future
   scaling step), a plain `SET` persists for the lifetime of the pooled
   connection and leaks one request's identity into the next request that
   reuses the connection — a cross-tenant data leak. `SET LOCAL` is
   scoped to the transaction and is safe under transaction pooling by
   construction.
2. **The application's database role must not be a table owner**, or
   `FORCE ROW LEVEL SECURITY` must be set on every RLS-protected table.
   Postgres table owners bypass RLS policies by default regardless of
   policy definitions — an easy, silent way to ship RLS that does nothing
   in production while passing tests run as a superuser/owner role
   locally. CI must run integration tests as the actual non-owner
   application role, not as the migration-owner role, specifically to
   catch this class of bug.

This `SET LOCAL` + transaction wrapper is hand-rolled middleware
regardless of ORM choice — SQLx does not provide this out of the box, and
neither would SeaORM or Diesel. It is implemented once as a connection-
acquisition helper (e.g. `db.begin_scoped(user_id)`) used by every
handler via the auth extractors defined in
[[0002-backend-web-framework]], so no handler can accidentally acquire an
unscoped connection.

## Consequences

**Positive:**
- Compile-time query checking (SQLx macros) catches column/type
  mismatches at build time, not runtime — valuable given the compliance-
  sensitive nature of hours/audit data.
- RLS enforced at the database layer is a second, independent barrier
  behind the application-layer checks in Axum extractors — defense in
  depth. Even a handler that forgets an authorization check cannot read
  or write rows outside its session's scope, because the database itself
  refuses.
- The offline `.sqlx` cache means CI does not need a live database to
  verify query correctness at compile time, only for integration tests
  against a Neon branch.

**Negative / accepted risk:**
- SQLx macro compile-time overhead is real and documented: 67.5% of
  compile time in one measured comparable project. This is an accepted
  cost, expected to grow as the schema grows, and should be watched via
  CI build-time metrics rather than ignored.
- The `SET LOCAL` + non-owner-role pattern is entirely hand-rolled and
  easy to get subtly wrong (e.g. a code path that opens a connection
  without going through the scoped-transaction helper). This is the
  single highest-leverage security-review item for Phase 1 and should be
  covered by a dedicated integration test suite that attempts
  cross-tenant reads/writes and asserts they fail.
- No ORM-level migration tooling comparable to Rails/Django exists; SQLx
  migrations are plain SQL files run via `sqlx migrate`, which is
  adequate but offers none of the schema-introspection convenience of a
  full ORM.

## Alternatives Considered

- **SeaORM.** Full ORM with migration DSL and active-record-style models.
  Rejected — the RLS `SET LOCAL` pattern still has to be hand-rolled
  regardless, so the ORM's main advantage (less boilerplate) is
  smaller than it appears, while its compile-time query safety is weaker
  than SQLx's macro-checked raw SQL, which matters more for compliance-
  critical audit/hours data.
- **Diesel.** Mature, compile-time-checked, but its query-builder DSL is
  more indirect than SQLx's near-literal SQL, adding a translation step
  when auditing exactly what a query does — a cost this project should
  not pay given the audit-trail requirements in
  [[0005-audit-log-and-co-leads]].
- **Supabase-style JWT-claim RLS policies.** Not applicable — superseded
  by [[0003-database-provider]]'s choice of Neon.

## Phase Gate

Unblocks Phase 1 (Foundation). The `SET LOCAL` scoped-transaction helper
must exist before any Phase 3/4 lead-scoped or Phase 8 admin-scoped
endpoint is written, since those phases' exit criteria assume this
pattern already exists.
