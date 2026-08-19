# ADR 0002: Backend Web Framework — Axum

## Status

Accepted — 2026-08-19

## Context

Per [[0001-language-and-stack-strategy]], the backend is Rust. The two
realistic candidates in the current ecosystem are Axum (Tokio-native, part
of the Tokio project) and Actix-web (older, actor-model heritage). The
research pass recommends Axum.

A specific security concern carries directly into this decision: the
original Next.js stack was flagged in `research-findings.md` for
CVE-2025-29927, where middleware-based auth was bypassable via spoofed
headers, because Next.js middleware runs before route handlers and can be
skipped by a crafted request. Whatever backend framework is chosen must
have an idiomatic pattern that makes "authorization enforced but
bypassable at the routing layer" hard to write by accident.

## Decision

Use **Axum** as the backend web framework, with authorization enforced via
**extractors** (`FromRequestParts`), not framework-level middleware, on
every mutating and admin handler.

Concretely: every handler that mutates state or requires elevated role
(lead/admin) must name an auth extractor type in its function signature,
e.g.:

```rust
async fn approve_hours(
    AuthUser(user): AuthUser,
    LeadOf(project_id): LeadOf,
    Json(payload): Json<ApproveHoursRequest>,
) -> Result<Json<HourEntry>, ApiError> { ... }
```

If the extractor is omitted, the handler simply won't compile against
payload types that assume an authenticated user — and more importantly, a
missing extractor is visible in a code review by reading the function
signature alone, not by tracing through a separate middleware
registration file. This is codified as a **review/lint rule**: no
mutating or admin handler may be merged without a named auth extractor in
its signature. Where feasible, add a `cargo clippy` or custom lint pass in
CI that flags `Json<...>`-accepting handlers on mutating HTTP methods
(`POST`/`PUT`/`PATCH`/`DELETE`) lacking a recognized extractor type.

## Consequences

**Positive:**
- Structurally harder to reproduce the CVE-2025-29927 middleware-bypass
  class: there is no separate middleware layer that silently gates access
  to routes by pattern-matching URLs. Authorization is a compile-time-
  visible part of each handler's own signature.
- Axum is Tokio-native, avoiding the actor-model impedance mismatch of
  Actix-web with the rest of the async ecosystem (SQLx, twilight, reqwest
  are all Tokio-based).
- Extractors compose: `LeadOf(project_id)` can itself depend on
  `AuthUser`, giving a natural place to encode "lead-scoped" checks
  required by Phase 3/Phase 4 exit criteria (build-roadmap.md).

**Negative / accepted risk:**
- "Structurally harder" is not "impossible." A handler can still omit the
  extractor and accept unauthenticated input if a reviewer misses it — the
  lint rule reduces but does not eliminate this risk, and the lint rule
  itself must be written and maintained (it does not ship with Axum).
- Axum's extractor pattern is less familiar to engineers coming from
  Express/Next.js/Django-style middleware chains; onboarding cost exists.
- This is a CRUD, form-heavy, I/O-bound workload — the domain Axum (and
  Rust generally) is least battle-tested in relative to systems/infra
  work. No enterprise case study of an Axum/SQLx admin-CRUD backend was
  found in the research pass. Documented friction to expect: async stack
  traces up to 100 frames deep (debugging cost), and this is stated
  plainly as an accepted tradeoff of the Rust-first mandate, not hidden.

## Alternatives Considered

- **Actix-web.** Mature, fast, but actor-model heritage creates friction
  with the rest of the Tokio-native stack (SQLx, twilight-http, reqwest).
  No compelling authorization-safety advantage over Axum's extractor
  pattern.
- **Middleware-based authorization (Tower `Layer`s) instead of
  extractors.** Rejected specifically because it reproduces the
  structural shape of the Next.js middleware-bypass class: authorization
  logic living outside the handler, gated by route pattern matching
  rather than by the handler's own required inputs.

## Phase Gate

Unblocks Phase 1 (Foundation). Directly satisfies the Phase 1 exit
criterion: "Role-based authorization is enforced server-side on every
mutating endpoint — never only in UI or middleware."
