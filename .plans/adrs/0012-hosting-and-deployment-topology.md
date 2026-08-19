# ADR 0012: Hosting and Deployment Topology

## Status

Accepted — 2026-08-19

## Context

`research-findings.md`'s original stack assumed Vercel hosting for a
Next.js monolith. The Rust pivot changes this fundamentally: the backend
is now a long-lived Axum server holding a database connection pool
([[0004-orm-and-row-level-security]]'s `SET LOCAL` pattern depends on
transaction-scoped connections from a pool), not a per-request serverless
function. The frontend ([[0011-frontend-architecture-typescript-
exception]]) is a separate TypeScript application. This ADR decides where
each piece runs and how they communicate securely.

## Decision

**Backend (Rust/Axum) + Postgres access: Fly.io.**

Rationale, in order of weight:
- **Shuttle.rs is confirmed shutting down** — excluded outright, not
  considered further.
- **Railway's managed Postgres has no SLA and is explicitly documented as
  unsuitable for mission-critical use** — a direct conflict with this
  application's audit/compliance requirements
  ([[0005-audit-log-and-co-leads]], [[0014-gdpr-article-27-
  representative]], [[0015-pipeda-breach-notification-and-privacy-
  officer]]). Note Neon is the actual Postgres provider per
  [[0003-database-provider]], so this specifically rules out Railway as
  an application-hosting choice too, for consistency of operational
  guarantees across the stack.
- **Vercel's official Rust runtime (beta, Dec 2025)** is function-per-
  serverless-request — a structural mismatch for a long-lived Axum server
  holding a DB connection pool (each invocation would need its own
  pool or a cold-start reconnect, undermining the connection-pooling
  benefit entirely, and complicating the `SET LOCAL`-per-transaction
  pattern's assumptions about connection lifecycle). Most teams
  currently prefer a dedicated host for this workload shape, per the
  research pass.
- Fly.io supports long-lived processes with persistent connection pools,
  has a documented track record hosting exactly this workload shape
  (Axum + Postgres), and hosts both the API server and the scheduled
  reconcile job (Discord role-sync, per
  [[0008-discord-integration-architecture]]) as Fly.io Machines/cron-
  equivalent scheduling.

**Frontend (TypeScript): standard frontend hosting** (Vercel or
Netlify — the specific choice does not affect this ADR's architectural
decisions and is left as a Phase 1 implementation detail, since the
frontend has no long-lived-connection requirement forcing a particular
host).

**Subdomain and cookie architecture:** the hosting split requires a
same-parent-domain subdomain layout — `app.example.org` (frontend),
`api.example.org` (backend) — so session cookies set by the Rust backend
can be scoped `Domain=.example.org` and remain **first-party** from the
frontend's perspective. This sidesteps third-party-cookie restrictions
(Safari ITP, Chrome's third-party-cookie phase-out) that would otherwise
break session auth if frontend and backend were on unrelated domains.

**CORS:** enforced via `tower-http::CorsLayer` on the Axum backend, with
an explicit origin allowlist (the frontend's exact origin, not a
wildcard) and `Access-Control-Allow-Credentials: true`, required because
session cookies are sent cross-origin (subdomain-to-subdomain) on every
frontend-to-backend API call.

## Consequences

**Positive:**
- Backend hosting choice is driven by the actual workload shape (long-
  lived connection pool) rather than defaulting to whatever hosted the
  original Next.js monolith — avoids a structural mismatch that would
  otherwise surface as connection-pool exhaustion or cold-start latency
  under Vercel's serverless Rust runtime.
- Explicitly ruling out Railway's Postgres for mission-critical use
  closes a gap the original spec didn't need to consider — directly
  relevant given this app's audit/compliance posture.
- Same-parent-domain + `Domain=.example.org` cookies avoid the more
  complex cross-site cookie workarounds (`SameSite=None; Secure` plus
  explicit third-party-cookie carve-outs) that an unrelated-domain split
  would require, and that are increasingly unreliable across browsers.

**Negative / accepted risk:**
- Fly.io is a smaller operator than Vercel/AWS; less mature tooling
  ecosystem, smaller community troubleshooting base. Accepted given the
  concrete disqualifiers on the alternatives (Shuttle shutting down,
  Railway's Postgres SLA gap, Vercel's serverless-shape mismatch).
- The subdomain architecture requires the Foundation to control DNS for a
  shared parent domain and provision both subdomains before Phase 1
  deployment — a small but real operational prerequisite, not purely a
  code change.
- CORS with credentials requires careful origin-allowlist maintenance
  (e.g. adding preview-environment origins for CI, per
  [[0003-database-provider]]'s Neon-branch-per-PR workflow) — a
  recurring small maintenance surface, not a one-time setup cost.

## Alternatives Considered

- **Shuttle.rs.** Excluded outright — confirmed shutting down.
- **Railway** (backend + Postgres). Rejected — Postgres SLA gap is
  disqualifying given compliance requirements; noted as a candidate only
  for genuinely non-critical auxiliary services, not the core
  application, and not adopted here to avoid a two-host operational
  split for no strong benefit.
- **Vercel's Rust runtime (beta).** Rejected for the primary backend —
  function-per-request shape conflicts with the long-lived connection
  pool this design depends on. Not excluded as a future option for
  genuinely stateless auxiliary Rust functions, but nothing in this
  design currently needs that.
- **Unrelated-domain frontend/backend split with `SameSite=None`
  cross-site cookies.** Rejected — more fragile under evolving
  browser third-party-cookie restrictions than a same-parent-domain
  first-party-cookie architecture; no offsetting benefit.

## Phase Gate

Unblocks Phase 1 (Foundation — where the backend actually runs) and
Phase 5 (Discord bot — reconcile job needs a scheduled-job host, resolved
here as Fly.io).
