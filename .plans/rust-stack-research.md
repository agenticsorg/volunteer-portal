# Rust Ecosystem Stack Research — Agentics Foundation Volunteer Portal

## Introduction

This document presents findings from a dedicated Rust-ecosystem research pass evaluating the technical stack pivot: every component in the original Next.js/TypeScript specification (concept.md) was assessed for Rust viability. The research culminated in the Architecture Decision Records series (ADR-0001 through ADR-0013), which record the per-component decisions that follow.

**Note:** All recommendations documented here were adopted into the ADR series. Cross-references below link each research item to its corresponding ADR decision.

---

## ITEM 2 — THE FRONTEND FORK — DECISIVE RECOMMENDATION (critical fork)

**Recommendation: Rust backend (Axum) + thin TypeScript/Next.js or SvelteKit frontend. Do NOT go full Rust-native frontend for this project.**

**Confidence: high / risk explicitly documented**

This is the single most consequential finding in the research pass — the one point where "Rust as much as possible" becomes a documented partial departure. The decision required evaluating three Rust-native web frameworks against this specific application's requirements.

### Version and activity data

Primary-source version/activity data (crates.io + GitHub APIs, not blog summaries — most "2026 Rust frontend" blog content was found to recycle stale/wrong version numbers):

| | Leptos | Yew | Dioxus |
|---|---|---|---|
| Stable version | 0.8.20 | 0.23.0 | 0.7.10 (0.8.0-alpha in progress) |
| GitHub stars | 21,215 | 32,784 | 38,811 |
| Recent downloads | 1,261,295 | 357,147 | 828,502 |
| Governance status | Creator announced May 2026: "lightly maintained," feature-complete, no 1.0 commitment, recruiting new maintainers, cites burnout | Active but slow cadence, ceding mindshare to Leptos | Active, YC-backed company, but pre-1.0 with ongoing breaking changes |

### The decisive fact: Leptos governance risk

**The single most consequential fact found: Leptos's sole lead maintainer publicly stepped back from active development in May 2026** (confirmed via GitHub issue, primary source) — the technically strongest Rust SSR framework is now a light-maintenance, no-committed-roadmap project. This is a disqualifying governance risk for something explicitly required to be "production-ready, commercial-grade" over a multi-year lifespan.

**Dioxus:** YC-backed company, most external institutional validation (Airbus/ESA usage — though that usage reads as desktop GUI, not confirmed as web-SSR). However, its web-SSR/fullstack path is still pre-1.0 with an SSR-correctness bug closed as recently as late 2024.

**Yew:** The stable choice, technically sound, but has clearly lost ecosystem momentum (3.5x lower downloads than Leptos). Active but slow cadence, ceding mindshare to Leptos.

### The real blocker: the accessible-component ecosystem gap

Accessibility tooling itself is NOT the blocker: axe-core/Playwright operate on the rendered DOM regardless of source framework (Leptos/Yew/Dioxus web targets compile to WASM that manipulates the real DOM via wasm-bindgen, not a canvas/shadow layer) — so prior Next.js research transfers cleanly here.

**What IS the blocker is the accessible-component ecosystem**, which is a roughly 100-900x scale gap by GitHub star/issue-count comparison:

- **React's Radix UI** (19,186 stars, WorkOS-backed)
- **React Aria/react-spectrum** (15,801 stars, Adobe-backed)

These represent years of professionally-resourced, production-hardened focus-management, ARIA-live-timing, and form-label-association engineering.

**The Rust equivalents** are single-team side projects:
- `radix-leptos` (21 stars, <1 year old)
- `leptos-forms-rs` (4 stars)
- The cross-framework `RustForWeb/radix` port is already archived/unmaintained (63 stars)

For a WCAG 2.1 AA app with bulk-action approval queues and multi-field forms, this means re-discovering focus-trap edge cases and ARIA-live timing bugs from scratch rather than inheriting battle-tested primitives — a real, unbudgeted tax on exactly the requirement this project can least afford to get wrong.

### Production evidence

No production case study was found (despite active searching, treated as evidence of absence, not proof of nonexistence) for any of the three frameworks matching "form-heavy, role-gated, accessible business web app."

### Honest tradeoff of the recommended split-stack path

You take on standard two-language-stack costs — a REST/JSON boundary to keep in sync, duplicate validation unless you generate TS types from Rust (via `ts-rs`/`specta`, well-supported 2026 patterns), two toolchains in CI. These are well-understood, well-tooled costs versus the comparatively uncharted governance and accessibility-ecosystem risks of any Rust-native frontend option for this specific app shape.

This also directly determines item 9's hosting split (Vercel-or-similar for the thin TS frontend, Fly.io for the Rust API) and the same-parent-domain cookie architecture discussed there.

**This is a genuine partial departure from "Rust as much as possible"** — flagged explicitly for the ADR, with the rationale that frontend accessibility-primitive maturity is a harder, less negotiable constraint than language purity for this specific app.

**Reference:** [[0011-frontend-architecture-typescript-exception]]

---

## ITEM 1 — Backend Framework: Axum vs Actix-web vs Loco.rs

**Confidence: likely (adoption numbers), confirmed (CVE-analog analysis)**

**Recommendation: Axum**

Axum is the strongest default: ~1.26M recent crates.io downloads, 190M+ total, Tokio-team-maintained, fastest-growing of the three in 2026. Actix-web has a longer track record and ~10-15% throughput edge under heavy load (multi-runtime-per-core model) but request volume won't be the constraint for this app. Loco.rs (a Rails-style app framework built ON TOP of Axum+SeaORM) hit v1.0.0 in July 2026 — worth watching but too short a production track record to trust as the primary choice yet.

### Authorization pattern analysis

On the CVE-2025-29927 analog question: no equivalent header-spoofing middleware-bypass CVE found for Axum/Actix. More importantly, Axum's idiomatic auth pattern differs structurally from Next.js middleware — the recommended approach is an extractor (`FromRequestParts`) named directly in the handler's function signature, not a separate URL-pattern-matched middleware layer the handler implicitly trusts. This makes the "framework skipped auth but still dispatched to the handler" bug class harder to reproduce accidentally, because the auth check is part of constructing the handler's own arguments rather than an out-of-band routing decision.

This is a discipline/convention benefit, not a compiler guarantee — a dev can still write a handler with no auth extractor at all. Recommend codifying "every mutating/admin handler must have an auth extractor in its signature" as a lint/review rule, not something assumed from framework choice.

**Reference:** [[0002-backend-web-framework]]

---

## ITEM 3 — ORM/DB Access Layer: SQLx vs SeaORM vs Diesel + Postgres RLS

**Confidence: likely, one sub-claim confirmed**

**Recommendation: SQLx (raw SQL, compile-time verification) + Postgres `SET LOCAL app.current_user_id`**

### Candidates

- **Diesel:** Strongest compile-time guarantees via DSL, but sync-first — needs the bolt-on `diesel-async` crate for use with Axum, and dynamic/conditional queries (common in admin filter/search UIs) are its known pain point.
- **SQLx:** `query!`/`query_as!` macros validate raw SQL against a real dev DB at compile time (offline `.sqlx` cache for CI). Async-native, full control over transaction/session handling.
- **SeaORM:** Async-native, weaker default compile-time checking, but better migration/scaffolding tooling; is what Loco.rs uses under the hood. SeaORM 2.0 shipped Jan 2026.

### RLS pattern (confirmed mechanism, likely as implementation guidance)

The standard pattern is `SET LOCAL app.current_user_id = $1` run inside the same transaction as the scoped query — `SET LOCAL` (not `SET`) is essential because it auto-reverts at transaction end, which matters critically if you're behind PgBouncer in transaction-pooling mode (physical connections get reused across unrelated requests; a plain `SET` would leak identity across tenants).

None of the three ORMs has first-class built-in support for this — it's hand-rolled application middleware in all three cases (open SQLx GitHub discussion #2783 confirms this is a known-but-manual pattern).

Also flag: Postgres table owners bypass RLS by default — the app's DB role must be a non-owner, or you need `FORCE ROW LEVEL SECURITY` set.

### Why SQLx

Raw SQL + compile-time checking gives the most direct control over exactly when/how the `SET LOCAL` + transaction wrapping happens, which matters because RLS needs precise transaction scoping an ORM abstraction could obscure.

**Reference:** [[0004-orm-and-row-level-security]]

---

## ITEM 4 — Database Provider: Supabase vs Neon for a Rust-Only Backend

**Confidence: likely**

**Recommendation: Neon**

The calculus does shift, moderately toward Neon. Supabase's differentiators (Auth/GoTrue, Storage, Realtime, Edge Functions) are all JS/Deno-first and none are naturally consumed from a Rust backend — you'd bypass them and connect via a plain Postgres connection string anyway.

Supabase's RLS-via-JWT-claims mechanism itself is NOT JS-coupled (you can mint/verify your own JWTs from Rust via `jsonwebtoken`), but if you're already hand-rolling your own role-gated auth in Rust (required regardless of provider per item 5), that remaining Supabase value shrinks further.

Neon gives "just Postgres" with better branching (useful for CI/preview envs) and pricing aligned to a backend service. Note: Neon was acquired by Databricks (~$1B, closed 2025) — a roadmap/lock-in consideration independent of the technical comparison.

**Reference:** [[0003-database-provider]]

---

## ITEM 5 — Authentication and OAuth in Rust

**Confidence: confirmed (crate maturity), likely (risk assessment)**

**Recommendation: Hand-rolled OAuth2/OIDC with `oauth2`, `openidconnect`, `tower-sessions`, manual explicit account linking**

### Building blocks maturity

Building blocks are individually mature and low-risk:
- `oauth2` crate (v5.0.0, 45.6M downloads, actively maintained, no known RUSTSEC advisories) for Discord
- `openidconnect` (same author) on top for Google since it's OIDC and you want ID-token verification
- `tower-sessions` (v0.15.0, actively maintained) and `axum-login` (built on tower-sessions, active) handle session plumbing
- `jsonwebtoken` (v11.0.0, 171M+ downloads) is boring and safe if needed

### The critical finding: No Auth.js equivalent

**There is no Auth.js-equivalent integration layer.** No crate provides a documented `Account`/identity-linking model or an equivalent of `allowDangerousEmailAccountLinking`. The multi-provider callback handling and — critically — the account-linking-by-email security decision is 100% hand-rolled application code sitting on your own users/identities tables.

This is real, non-trivial implementation risk, not because the crates are bad but because you're rebuilding logic Auth.js gave you for free (and even then flagged as a known attack vector).

### Concrete requirement

Store `email_verified`/`verified` status per identity (Discord's OAuth user object has a `verified` boolean; Google's OIDC ID token has `email_verified`), and never auto-link on email match without checking it. Budget explicit engineering + security-review time for this module — "we're in Rust" does not make this safer by default.

**Reference:** [[0007-authentication-oauth-and-account-linking]]

---

## ITEM 6 — Discord Integration: Serenity vs Twilight

**Confidence: confirmed**

**Recommendation: `twilight-http` + `twilight-model`**

Serenity's default feature set includes gateway/WebSocket machinery on by default — you'd have to explicitly opt out (`default-features = false`) to get REST-only, and its `Client`/`EventHandler` model is built around a persistent-process bot, not your cron-job + HTTP-interactions-endpoint architecture.

Twilight is natively à la carte: `twilight-http` is a standalone REST client with no gateway dependency to trim, `twilight-model` gives typed serde models, no framework overhead. Twilight also handles Discord's rate limiting correctly out of the box, which is easy to get wrong hand-rolling it and a real risk when a reconcile job hits REST endpoints across many guild members.

Neither crate handles interaction signature verification for you — that's a small, well-specified piece of code (`ed25519-dalek`, v3.0.0, very mature, old RUSTSEC advisory doesn't apply to verify-only usage) you write regardless of crate choice.

**Reference:** [[0008-discord-integration-architecture]]

---

## ITEM 7 — PDF Generation: Typst vs Printpdf vs Genpdf

**Confidence: confirmed**

**Recommendation: Typst (driven programmatically)**

Typst is usable as an in-process Rust library (not just CLI) via the `typst` crate + community wrapper `typst-as-lib` (caveat: wrapper API "not really stable" per its own README) + `typst-pdf`. There's a documented production case (InfoQ DevSummit Munich 2025 talk, "Million PDFs: Building a Modern Document Infrastructure with Rust and Typst").

Printpdf is actively maintained (v0.12.6, Aug 2026) as a solid low-level fallback but has no templating/accessibility support. Genpdf is dead upstream (last release 2021) — avoid.

### Accessibility finding (directly answers the gap)

**Typst as of v0.14 (2025) writes Tagged PDF by default and supports full PDF/UA-1 export** (`--pdf-standard ua-1`), including alt-text and export-time validation that blocks export on critical accessibility issues. Printpdf/genpdf have no structure-tree support.

For comparison, @react-pdf/renderer explicitly does NOT support tagged PDF (confirmed via maintainer comment on a long-open GitHub issue).

**The Rust ecosystem is genuinely better here than the JS path researched previously — but only via Typst specifically.**

**Reference:** [[0009-verification-letter-pdf-generation]]

---

## ITEM 8 — Email: Lettre vs HTTP API

**Confidence: confirmed**

**Recommendation: Call the HTTP API directly via `reqwest`; prefer Postmark for deliverability, Resend as a strong second choice**

Skip lettre/SMTP — it's transport-only (no templating/retries/observability), and notably Railway now blocks outbound SMTP platform-wide by default (recommends HTTP-API providers instead in its own docs), which matters for item 9's hosting choice.

Resend has an official, actively-maintained Rust SDK (`resend-rs`). Postmark has no official Rust SDK but stronger dedicated transactional deliverability (45-day log retention vs Resend's 1-3 days on top of AWS SES).

**Reference:** [[0010-email-provider-and-delivery]]

---

## ITEM 9 — Hosting/Deployment Topology: Fly.io vs Railway vs Shuttle vs Vercel Rust Runtime

**Confidence: confirmed — includes a correction to the research premise**

**Recommendation: Fly.io for backend + jobs; standard frontend hosting (Vercel or Netlify)**

### Candidates and exclusions

**Shuttle.rs is shutting down** — confirmed via official docs, Pro-tier projects stopped Jan 16 2026, Community tier had an early-2026 migration deadline, replacement platform "Neptune" is still beta and explicitly not yet suitable for all production workloads. **Eliminate Shuttle from consideration entirely** — this contradicts what would've been a reasonable assumption from older training data.

Fly.io and Railway are the two viable candidates. Fly.io: Postgres story shifted to "Fly Managed Postgres" (the old Supabase-managed offering was deprecated April 2025), some MPG features still "in development," cron via `fly machine run --schedule=` or a community tool, some 2025-2026 incidents tied to its internal networking/service-discovery layer worth checking before committing. Railway: managed Postgres explicitly has **no SLA and is documented as "not suitable for anything mission-critical"** — a real concern for this app's compliance/audit requirements; cron is first-class and easy (crontab expression, 5-min granularity).

**Vercel + Rust — verified current state, corrects a likely stale assumption**: Vercel now has an official first-party Rust runtime, launched to public beta December 8, 2025, running on Fluid Compute with an official Rust/Axum starter. The old community runtime is deprecated/archived. So "Vercel doesn't support Rust" would now be wrong. However it's still beta and is a function-per-request serverless model, not a long-lived process — awkward for an Axum server holding a Postgres connection pool. Most teams in this position still prefer a dedicated host.

### Subdomain and cookie architecture (if splitting frontend/backend)

If splitting frontend (Vercel/TS) from backend (Fly or Railway/Rust):

**CORS** needs explicit origin allowlisting + `Access-Control-Allow-Credentials: true` (`tower-http::CorsLayer`).

**Latency:** tens-to-100+ms per cross-region hop, mitigate by co-locating regions.

**Cookies:** Cross-site cookies need `SameSite=None; Secure` and are increasingly restricted by Safari ITP / Chrome — strongly recommended fix is to put frontend and backend on the same parent domain via subdomains (`app.example.com` / `api.example.com`) so the session cookie can be scoped `Domain=.example.com` and become first-party, sidestepping the SameSite/third-party-cookie problem entirely. Alternative is bearer-token auth, at the cost of manual storage/refresh and slightly higher XSS exposure.

**Reference:** [[0012-hosting-and-deployment-topology]]

---

## ITEM 10 — Commercial-Grade Viability — Honest Flag, Not Just Formality

**Confidence: confirmed (gaps), likely (qualitative friction reports)**

No enterprise case study of an Axum/Actix+SQLx+Postgres admin-CRUD backend was found despite targeted searching — Rust's famous production stories (Discord, Dropbox, Cloudflare) are systems/infra/perf-critical, not form-heavy CRUD. What exists is small-team indie SaaS evidence only (e.g., Meteroid, a 6-person billing SaaS on Axum/SQLx), whose own retrospective flags single-maintainer library risk and recommends avoiding premature optimization to stay productive.

### Real, sourced friction

A candid 2026 JetBrains retrospective on Rust web dev reports:
- Async stack traces up to 100 frames deep
- SQLx macro expansion consuming 67.5% of one measured project's compile time
- Its own conclusion that "for simpler projects, Python will still get you there faster"

**Hiring and talent costs:**
- Rust devs carry a real hiring premium (~24% above median, ~$145K avg US)
- The senior talent pool "has not kept pace" with demand
- No Rust web framework is at Django/Rails admin-tooling parity yet — SeaORM's new "SeaORM Pro" admin panel is the closest analog but young/commercial, not an ecosystem standard

### Honest bottom line

A low-to-medium-traffic, form-heavy, admin-approval-workflow CRUD app is close to the least Rust-favorable workload profile in the current evidence base — it's I/O-bound (Postgres/OAuth waits), not CPU-bound, so Rust's core performance/safety advantages are underused while the costs (slower iteration, thinner "batteries included" tooling, smaller/pricier hiring pool) are real and specifically pronounced for this category.

This doesn't argue against the mandated direction, but it should be stated plainly in the ADR rather than downplayed.

**Reference:** [[0001-language-and-stack-strategy]], [[0002-backend-web-framework]]

---

## ITEM 13 (Deferred to Phase 9) — Semantic Matching Vector Layer: Rust-Native vs. `ruvector`

**Confidence: deferred / Phase 9 only, not required for core system**

**Recommendation: TypeScript `ruvector` (npm-only) as a second, narrowly-scoped exception**

This is not researched in the same depth as the core-path components because semantic matching is explicitly Phase 9 (a differentiator, not part of the "first usable portal" milestone per concept.md section 11).

### Finding

`ruvector` is confirmed real, MIT-licensed npm package (v0.2.41, actively maintained). Rust-native vector-search crates exist for general-purpose use but do not match `ruvector`'s specific fit for this application's stated need (semantic search over short free-text skill descriptions with HNSW indexing) closely enough to justify reimplementing or substituting at this stage.

### Rationale for the exception

This is a bounded, optional, Phase-9-only layer (not core). Rust-native vector crates exist but lack `ruvector`'s specific fit for free-text skill matching. Premature to re-engineer for a differentiator that must not be attempted before Phases 1–8 stabilize.

**Reference:** [[0013-semantic-matching-vector-layer]]

---

## Summary

Ten research items across the Rust ecosystem have been evaluated and mapped to architecture decisions. Two explicit, documented exceptions to "Rust as much as possible" emerged:

1. **Frontend:** TypeScript (Next.js or SvelteKit), not Rust-to-Wasm — driven by governance risk (Leptos), maturity gaps (Dioxus), and the accessible-component ecosystem gap that React's Radix UI / React Aria solve but Rust has not.
2. **Phase 9 semantic matching:** TypeScript `ruvector` as a bounded, optional layer — Rust-native alternatives lack the specific maturity `ruvector` offers for this narrow use case.

Everything else — the backend, all business logic, all data access, all external-service integration except the frontend's API calls — remains Rust. The two-language stack is deliberate, justified, and architecturally sound for this application's requirements and timeline, with specific risk acknowledgment (commercial-grade CRUD backend ecosystem immaturity, hiring costs, hiring pool constraints) documented in the ADRs.

All recommendations have been adopted into the ADR series. This document and the ADRs together form the complete technical stack research foundation for Phase 1 Foundation implementation.
