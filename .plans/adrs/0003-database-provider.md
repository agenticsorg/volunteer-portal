# ADR 0003: Database Provider — Neon

## Status

Accepted — 2026-08-19

## Context

`research-findings.md` left "Supabase or Neon" as an open decision,
framing it primarily around where role-scoped access control lives
(database RLS vs. application layer). The Rust pivot changes the
calculus: Supabase's differentiators beyond managed Postgres — Auth,
Storage, Realtime, Edge Functions — are all JS-first client SDKs and add
no value to a Rust backend that is not using the Supabase JS client.

Note for roadmap: Neon was acquired by Databricks (~$1B, closed 2025).
Recorded here as a roadmap consideration, not a blocker — Neon continues
to operate as a managed Postgres service post-acquisition.

## Decision

Use **Neon** as the managed Postgres provider.

Role-scoped access control moves into the application layer (Rust
service), not database RLS policies written against Supabase-style JWT
claims. See [[0004-orm-and-row-level-security]] for how RLS is still used
— via Postgres native `SET LOCAL` session variables driven by the Rust
service, not Supabase's JWT-claim policy model.

Neon's branching feature (instant copy-on-write database branches) is
adopted for CI and preview environments: each PR gets a Neon branch,
migrations run against it, tests execute against real Postgres rather
than a mock, and the branch is discarded on merge/close.

## Consequences

**Positive:**
- No wasted surface area: nothing in the stack pulls in Supabase's
  JS-first Auth/Storage/Realtime/Edge Functions, all of which would be
  unused capability paid for in cognitive overhead.
- Neon branching gives cheap, real-Postgres CI/preview databases —
  directly useful given [[0004-orm-and-row-level-security]]'s SQLx
  offline query-cache workflow needs a real schema to validate against in
  CI.
- Avoids coupling the app's identity model to Supabase Auth's JWT-claim
  shape, which would need to be reconciled against the hand-rolled Rust
  auth layer in [[0007-authentication-oauth-and-account-linking]] anyway.

**Negative / accepted risk:**
- All role-scoping logic is application code, not declarative database
  policy — more code at the security boundary than a Supabase-RLS
  approach would require, and that code must be correct on every query
  path, not just declared once per table. Mitigated by
  [[0004-orm-and-row-level-security]]'s `SET LOCAL` pattern applied
  uniformly at the transaction layer.
- Post-Databricks-acquisition roadmap risk: pricing, feature priorities,
  or product direction could shift. No specific negative signal exists as
  of this writing; flagged for periodic reassessment, not as a current
  blocker.

## Alternatives Considered

- **Supabase.** Rejected for a Rust backend — its value proposition
  (Auth/Storage/Realtime/Edge Functions client SDKs) is JS-first and
  unused here. Supabase's Postgres-as-a-service layer alone offers no
  advantage over Neon for this stack, and Neon's branching model is
  better suited to the SQLx offline-cache CI workflow.
- **Self-hosted Postgres (Fly.io Postgres or a VM).** Rejected — adds
  operational burden (backups, point-in-time recovery, patching) that a
  managed provider absorbs, with no offsetting benefit for a small team.

## Phase Gate

Unblocks Phase 1 (Foundation) schema/scaffold work.
