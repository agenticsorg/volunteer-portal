# ADR 0001: Language and Stack Strategy — Rust-First

## Status

Accepted — 2026-08-19

## Context

The project was originally scoped in `concept.md` as a Next.js/TypeScript
application on Vercel, and validated as such in `research-findings.md`. The
user has since mandated a hard architecture pivot: **implementation must be
Rust as much as possible, TypeScript only where Rust genuinely doesn't work,
other languages as a last resort.** The end result must be a
high-fidelity, production-ready, commercial-grade solution, not a scaffold.

A dedicated Rust-ecosystem research pass evaluated every component in the
original stack (web framework, ORM, database, auth, Discord integration,
PDF generation, email, hosting, frontend) for Rust viability. This ADR
records the top-level strategy; ADRs 0002–0013 record the per-component
decisions that follow from it.

This ADR exists because "Rust as much as possible" is a mandate, not a
specification — every component needs an explicit language decision with
its own rationale, or the mandate becomes an unenforceable slogan that
different phases interpret differently.

## Decision

Adopt a **Rust-core, TypeScript-exception** architecture:

| Component | Language | Rationale (detail in linked ADR) |
|---|---|---|
| Backend API / business logic | Rust (Axum) | [[0002-backend-web-framework]] |
| Data access / ORM | Rust (SQLx) | [[0004-orm-and-row-level-security]] |
| Auth (OAuth, sessions) | Rust (hand-rolled) | [[0007-authentication-oauth-and-account-linking]] |
| Discord integration | Rust (twilight) | [[0008-discord-integration-architecture]] |
| PDF generation | Rust (Typst) | [[0009-verification-letter-pdf-generation]] |
| Email sending | Rust (reqwest + provider HTTP API) | [[0010-email-provider-and-delivery]] |
| **Frontend (web UI)** | **TypeScript** (Next.js or SvelteKit) | [[0011-frontend-architecture-typescript-exception]] — sanctioned exception |
| Vector/semantic matching (Phase 9 only) | TypeScript (`ruvector`, npm-only) | [[0013-semantic-matching-vector-layer]] — sanctioned exception |
| Build/dev tooling (ruflo, CI scripts) | Not counted against the mandate | Development-time only, not shipped runtime |

Two components are explicit, documented exceptions to "Rust as much as
possible," not silent scope creep:

1. **The frontend is TypeScript**, not a Rust-to-Wasm framework
   (Leptos/Yew/Dioxus). Full rationale in ADR 0011 — in short, the
   accessible-component ecosystem gap (React's Radix UI / React Aria vs.
   single-team Rust ports with an already-archived cross-framework port) is
   an unacceptable risk for a WCAG 2.1 AA commercial application, and this
   risk is unrelated to whether Rust "can" render a DOM.
2. **The Phase 9 semantic-matching layer** may use `ruvector` (TypeScript,
   npm-only, no Rust equivalent with comparable maturity) as a bounded,
   optional differentiator layer — never the deterministic core.

Everything else — the entire backend, all business logic, all data access,
all external-service integration except the frontend's calls to the Rust
API — is Rust.

## Consequences

**Positive:**
- A single, auditable table exists (this ADR) that any contributor or
  future agent can check against instead of guessing per-component.
- The two TypeScript exceptions are narrow, justified, and isolated behind
  a typed API boundary (see ADR 0011's `ts-rs`/`specta` decision) — they do
  not leak Rust's absence into the compliance-critical core (auth, RLS,
  audit log, PDF generation all stay Rust).

**Negative / accepted risk (must not be softened, per project mandate):**
- This is a two-language stack, not a one-language stack, despite the
  "Rust as much as possible" framing. Contract drift between the Rust API
  and TypeScript frontend is a real, ongoing engineering cost, mitigated
  but not eliminated by generated types.
- Rust's CRUD/admin-tooling ecosystem is immature relative to
  Django/Rails/Next.js. There is no first-party admin-panel generator, no
  large body of "how to build a form-heavy Rust web app" prior art. See
  ADR 0002 for the full honest risk flag on commercial viability.
- Hiring: Rust carries a documented ~24% wage premium (~$145K avg US) with
  a talent pool that has not kept pace with demand. This is an accepted
  cost of the user's explicit mandate, not an oversight.

## Alternatives Considered

- **Full TypeScript (original concept.md stack).** Rejected — supersedes
  the user's explicit pivot mandate, not a technical rejection.
- **Full Rust including frontend (Leptos/Yew/Dioxus).** Rejected — see ADR
  0011. Governance risk (Leptos maintainer stepped back May 2026,
  no 1.0 commitment) and accessible-component ecosystem immaturity make
  this the wrong tradeoff for a WCAG 2.1 AA commercial app, despite being
  the "purer" reading of the mandate.
- **Rust for backend only, no typed contract generation, hand-maintained
  TS types.** Rejected — invites drift; `ts-rs`/`specta` cost is low
  relative to the risk of silent API/frontend mismatches in a compliance
  context (audit log, hours data).

## Phase Gate

Unblocks all of Phase 1 (Foundation) — per build-roadmap.md, "the
Rust/TypeScript split is stated per-component" is an explicit Phase 0 exit
criterion, satisfied by the table above.
