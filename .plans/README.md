# Agentics Foundation Volunteer Portal — Planning & Implementation

## What is this folder?

This `.plans/` directory contains the complete planning documentation for the Agentics Foundation Volunteer Portal: a production-ready commercial-grade volunteer management system built in Rust, with TypeScript exceptions where justified by ecosystem maturity or compliance risk.

**Reading order:**
1. `concept.md` — Product specification and requirements (original scope)
2. `research-findings.md` — Pre-implementation validation pass (Next.js/TypeScript stack, now superseded for language choices but compliance/schema findings still valid)
3. `rust-stack-research.md` — Rust ecosystem research findings for all 10 technology choices
4. `build-roadmap.md` — Phased build plan with phase sequencing and exit criteria
5. `adrs/` — Architecture Decision Records (0001–0016, the accepted decisions blocking Build Sequence)
6. `ddd/` — Domain-Driven Design model (7 bounded contexts with aggregates, invariants, ports, and domain events)

---

## The Rust-First Architecture

### What's Rust

- **Backend API** (Axum)
- **Data access layer** (SQLx + Postgres `SET LOCAL` RLS pattern)
- **Database provider** (Neon managed Postgres)
- **Authentication** (OAuth2/OIDC, manual account linking, `tower-sessions`)
- **Discord integration** (twilight-http for scheduled reconciliation + `/link` command)
- **PDF generation** (Typst, with PDF/UA-1 tagged output)
- **Email sending** (Postmark HTTP API via `reqwest`)
- **Hosted on** (Fly.io for the long-lived Axum service + scheduled jobs)

### Sanctioned TypeScript exceptions

**1. Frontend: Next.js or SvelteKit (ADR-0011)**
- **Why:** Leptos governance risk (maintainer stepped back May 2026), Dioxus pre-1.0 immaturity, Yew stalled momentum. **Most critically:** React's accessible-component ecosystem (Radix UI 19k stars, React Aria 15k stars) is years of professionally-hardened focus management and ARIA semantics. Rust-native equivalents are single-team <25-star projects; the one cross-framework port is archived. For a WCAG 2.1 AA commercial app with bulk-approve forms, building this from scratch is unbudgeted, high-risk work landing where accessibility defects are most costly.
- **Contract drift mitigation:** Types generated from Rust via `ts-rs`/`specta` as part of the build.

**2. Phase 9 Semantic Matching: `ruvector` (TypeScript, npm-only) (ADR-0013)**
- **Why:** Bounded, optional, Phase-9-only layer (not core). Rust-native vector crates exist but lack `ruvector`'s specific fit for free-text skill matching. Premature to re-engineer for a differentiator that must not be attempted before Phases 1–8 stabilize.
- **Isolation:** Separate service, read-only data access, authorization re-checked before results shown.

All other components remain Rust. These exceptions are narrow, justified, and isolated behind typed API boundaries — they do not permeate the compliance-critical core (auth, RLS, audit log, PDF generation all Rust).

---

## Architecture Decision Records (ADRs)

| # | Title | Decision | Unblocks phase(s) |
|---|---|---|---|
| 0001 | Language & Stack Strategy | Rust-core, TypeScript-exception (frontend + Phase 9 vector) | 1–9 |
| 0002 | Backend Web Framework | Axum (extractors for auth, not middleware) | 1, all mutating endpoints |
| 0003 | Database Provider | Neon (managed Postgres, branching for CI) | 1 schema/scaffold |
| 0004 | ORM & Row-Level Security | SQLx + `SET LOCAL app.current_user_id` (Postgres native RLS) | 1, 3, 4 (auth boundaries) |
| 0005 | AuditLog Table & Co-Leads | Add `audit_log` + `project_lead` tables; framework-level audit writes | 1 (schema), 3, 8 |
| 0006 | Assignment/Event Model & Hours Semantics | `Project.type` discriminator; `Assignment.participation_mode` (Contributor\|Attendee); events don't accrue hours except for the lead/host | 3, 4 (schema), Phase 8 (reporting) |
| 0007 | Authentication & Account Linking | OAuth2/OIDC hand-rolled; manual, explicit linking (no auto email-match) | 1, 2 |
| 0008 | Discord Integration | `twilight-http` REST-only (no TypeScript exception needed) | 5 |
| 0009 | PDF Generation | Typst (native PDF/UA-1 tagged output, closes WCAG gap) | 6 |
| 0010 | Email Provider & Delivery | Postmark (HTTP API via `reqwest`); Resend as fallback | 7 |
| 0011 | Frontend Architecture | TypeScript (Next.js or SvelteKit), with `ts-rs`/`specta` type generation | 1–4, 6, 8–10 UI work |
| 0012 | Hosting & Deployment Topology | Fly.io for backend + jobs; same-parent-domain subdomains for CORS/cookies | 1, 5 |
| 0013 | Semantic Matching Vector Layer | `ruvector` (TypeScript exception for Phase 9 only) | 9 |
| 0014 | GDPR Art. 27 — EU Representative | Rely on "occasional, small-scale, low-risk" exemption; 10-volunteer threshold trigger for designating a representative | 10 (compliance) |
| 0015 | PIPEDA Breach Notification & Privacy Officer | Designate named Privacy Officer; documented breach-response runbook; use `audit_log` for incident records | 10 (compliance) |
| 0016 | Ruflo Plugin Installation | Correction: ruflo-* plugins install via Claude Code plugin marketplace, not npm | All phases (documentation) |

**Reading:** Each ADR is a self-contained decision record with context, rationale, consequences, alternatives, and phase-gate implications. ADRs supersede `concept.md` where they diverge (e.g., ADR-0011 overrides concept.md's original Next.js+TypeScript stack choice in light of the Rust pivot mandate).

---

## Domain-Driven Design Model

The DDD analysis resolved product ambiguities (event-hours semantics) and established 7 bounded contexts, each with its own aggregates, invariants, repositories, and domain events.

| Context | Owns | Key aggregate(s) |
|---|---|---|
| **Identity & Access** | Volunteer identity, Discord/Google OAuth linkage, roles (volunteer/lead/admin), sessions | `Volunteer` with `Agreements`, `OAuthLink`; no `Session` in domain (infra only) |
| **Projects & Assignments** | Project (project + event type), co-lead roster, apply/approve flow | `Project` (discriminator-based, both project-type and event-type), `ProjectLead` join, `Assignment` |
| **Hours & Verification** | Hour logging, approval queue, manual admin adjustments, on-demand letter generation | `HourEntry`, `VerificationLetterService` (no stored `VerificationLetter` — rendered on demand) |
| **Discord Integration** | Anti-corruption layer for Discord REST API | `RoleReconciler` (domain service), `LinkCommandHandler`, no long-lived aggregate |
| **Notifications** | 5 transactional email triggers + meeting reminders | `NotificationAttempt` (delivery log, not rich aggregate) |
| **Compliance & Audit** | Audit log queries, data-subject requests (export/deletion) | `AuditLog` (read-only at domain layer), `DataSubjectRequest` aggregate |
| **Kernel** | ID types, `DomainEvent`/`AuditableEvent` traits, `ActorId`, `UnitOfWork` guard (RLS transaction wrapper) | Shared vocabulary across contexts |

**Key decision: `Assignment.participation_mode` (Contributor|Attendee) computed once at construction**

This enforces the event-hours rule at the source: event-type projects' ordinary attendees get `Attendee` mode (can't accrue hours); the event's own lead/host gets `Contributor` mode (can accrue hours, because hosting a recurring meetup is real work per concept.md section 1). `HourEntry` construction is refused for non-Contributor assignments — a hard constraint at two layers (app + Postgres trigger). This means verification letters, hours reports, and Discord notifications need no special event-type filtering logic; the exclusion already happened at the source.

**Why this matters:** If the Foundation later decides ordinary attendees should accrue hours (e.g., for setup/teardown time), the change is localized to `Assignment::apply`'s `participation_mode` computation. `HourEntry::log`'s invariant doesn't need to change — it already defers entirely to `participation_mode`. One source of truth, one place to revisit.

**Read DDD files in order:** `context-map.md` (overview, communication mechanisms, the event-hours decision), then each context's file.

---

## Build Roadmap: Phase Sequencing & Exit Criteria

**Phases 1–4 together = first usable portal** (per concept.md Build Sequence steps 1–4).

| Phase | Scope | Hard dependencies | Exit criteria include |
|---|---|---|---|
| **0 — Architecture Decisions (gate)** | Resolve all blocking decisions (Rust/TS split, framework picks, hosting, event-hours semantics, GDPR/PIPEDA) | None (parallel with Rust-stack research) | Every decision has an accepted ADR; schema drafted; Rust/TS split stated per-component |
| **1 — Foundation** | Rust scaffold, 5-table schema (Volunteer, Project, Assignment, HourEntry, AuditLog, ProjectLead), Discord OAuth, role model | Phase 0 (DB/RLS model, Rust framework, hosting split) | Role-based authz server-side on every mutating endpoint; AuditLog wired at framework level; schema migrations reproducible; Discord OAuth round-trips in dev |
| **2 — Onboarding** | Signup form, agreement capture (CoC, IP, age 18+), admin approval | Phase 0 (account-linking ADR), Phase 1 | Account-linking policy implemented + tested; agreements stored with timestamps; WCAG 2.1 AA automated + manual pass on signup flow |
| **3 — Projects** | Project directory by skill, apply-to-project, lead roster (add/remove/reassign), event signup | Phase 0 (Assignment/event model), Phase 1 | Lead-scoped authz server-side; roster changes audit-logged; WCAG 2.1 AA on directory, apply, roster views |
| **4 — Hours** | Self-logged entries, lead approval queue, manual admin adjustments, cumulative totals | Phase 0 (event-hours semantics), Phase 3 | Lead-scoped approval authz; manual adjustments audit-logged with before/after; event-hours behavior enforced at app + schema boundary; WCAG 2.1 AA on entry/approval flows |
| **5 — Discord bot** | Scheduled reconcile job (idempotent), `/link` command, DM/channel notifications | Phase 0 (hosting split, Discord crate maturity), Phase 1 | Reconcile idempotent & self-healing (tested: desync, run, verify correction); `/link` tested E2E against real Discord guild; no persistent Gateway bot |
| **6 — Verification Letters** | PDF rendering from approved hours only, Foundation letterhead, on-demand (never stored) | Phase 0 (PDF library/PDF-UA), Phase 4 | PDF/UA tagging confirmed working (veraPDF validation); only approved hours included; brand compliance verified; not persisted |
| **7 — Email** | 5 transactional triggers, brand-system templates, delivery-failure handling | Phase 0 (provider decision), 2/3/4/6 | All 5 triggers tested E2E against real provider; brand compliance on every template; failure handling defined |
| **8 — Admin** | Roster with CSV export, hours report by project/date range, manual hour adjustment with audit trail | Phase 1 (AuditLog exists), 3, 4 | Every admin mutation produces AuditLog entry (coverage test); CSV export tested on non-trivial dataset; hours totals reconcile with source |
| **9 — Semantic Matching** | Vector layer over skills/project descriptions, additive (deterministic SQL directory search remains) | Phase 0 (Rust vs TS for vector layer), 1–8 stable | Matching quality validated against labeled test set; deterministic search untouched; no cross-project data leakage |
| **10 — Compliance Hardening** | Full-site WCAG audit, privacy policy + retention, deletion path, breach notification runbook, encryption/backup restore-tested | Phase 0 (GDPR/PIPEDA decisions), all prior | Full-site WCAG 2.1 AA (automated + manual); privacy policy published; deletion E2E tested; privacy officer designated & runbook documented; backups restore-tested |

**Milestone:** Phases 1–4 complete = first usable portal.
**Differentiator:** Phase 9 must not be attempted before Phases 1–8 stable (per concept.md).

**Key cross-document reconciliation:** ADR-0006 was amended after the DDD pass identified that event hosts (meeting leads) should accrue hours, contrary to the original blanket "events never accrue hours" rule. The amendment introduced `Assignment.participation_mode` to distinguish Contributor (host) from Attendee (ordinary meetup attendee). ADR-0009 was corrected to match. Both files now align with `projects-assignments.md` and `hours-verification.md` in the DDD model — this is a worked example that the planning documents are internally consistent, not just individually plausible.

---

## Production-Ready Completeness Check

**Is this document set sufficient to build a production-ready commercial-grade system per the user's requirement?**

### What's complete

✅ **Architecture:** All per-component language/library decisions have accepted ADRs with explicit rationale, risk acknowledgment, and phase-gate implications.

✅ **Domain model:** 7 bounded contexts with aggregates, invariants, repositories, domain events, and cross-context communication (direct ports + transactional outbox).

✅ **Schema:** Five core tables (Volunteer, Project, Assignment, HourEntry, AuditLog) plus ProjectLead join table, all RLS-protected via `SET LOCAL app.current_user_id`, with deployment to Neon and CI branching strategy defined.

✅ **Build sequencing:** 10 phases with explicit dependencies, exit criteria, and milestone definitions. Phase 0 gate ensures no code is written until all blocking decisions are resolved.

✅ **Compliance scope:** WCAG 2.1 AA (per-phase + full-site audit), PIPEDA (privacy officer, breach notification, retention policies), GDPR (Art. 27 threshold + trigger conditions), audit trail (AuditLog table with before/after snapshots).

✅ **Authentication:** OAuth2/OIDC with manual, explicit account linking (no auto email-match); `tower-sessions` server-side sessions; hand-rolled Discord linking flow.

✅ **Hours & verification letters:** Event-hours semantics explicitly resolved (Contributor/Attendee distinction); verification letters rendered on demand from approved hours only, never stored; PDF/UA-1 tagging via Typst.

✅ **Discord integration:** Scheduled REST-only reconciliation (idempotent, self-healing), `/link` command with Ed25519 signature verification, DM/channel notifications via Postmark/Discord.

✅ **Cross-context consistency:** Domain events flow through a transactional outbox (at-least-once delivery for reactive concerns) and a scoped-transaction helper (exactly-once for audit capture). Framework-level AuditLog writes prevent any mutation path from being accidentally unaudited.

### Known gaps or honest concerns

⚠️ **Rust CRUD ecosystem maturity:** No enterprise case study of Axum/SQLx admin-CRUD backend at scale was found. Form handling, validation patterns, and developer onboarding are less battle-tested than Django/Rails/Next.js equivalents. Mitigated by: explicit risk acknowledgment in ADR-0001/0002, per-phase validation gates in build-roadmap.md, and this being a stated, accepted tradeoff of the Rust-first mandate (not an oversight).

⚠️ **Hand-rolled authentication:** No Auth.js equivalent in Rust. OAuth2/OIDC implementation is custom application code, not a mature library. Mitigated by: explicit scope in ADR-0007, named "openidconnect JWKS verification" as a Phase 1/2 security-review priority, and pattern (manual linking) being simpler and safer than Auth.js's default.

⚠️ **Typst PDF/UA-1 validation:** PDF/UA-1 export is a newer Typst capability. Output must be validated with veraPDF before Phase 6 ships, not just trusted on the flag. Named in Phase 6 exit criteria; mitigated by governance (explicit gate, not silent gap).

⚠️ **Hiring & talent costs:** Rust wage premium (~24%) and a talent pool that hasn't kept pace with demand. Accepted as part of the user's explicit mandate, not an oversight. Documented in ADR-0001/0002 so it's not lost in retrospectives.

⚠️ **Two-language stack:** Frontend is TypeScript, not Rust. Contract drift between Rust API and TypeScript frontend is a real, ongoing cost mitigated but not eliminated by `ts-rs`/`specta` type generation. Scope is narrow (frontend only, plus Phase 9's optional vector layer); the choice is justified (accessible-component ecosystem gap, governance risk of Rust frameworks). Named in ADR-0011 as explicitly not a hidden risk.

### Decisions deferred (by design)

✅ **Frontend framework choice:** ADR-0011 accepts Next.js or SvelteKit; specific pick is Phase 1 implementation detail (both consume the same generated API types, neither has a load-bearing advantage for this app's needs).

✅ **Email provider:** ADR-0010 prefers Postmark; Resend explicitly endorsed as acceptable fallback if pricing/onboarding proves a blocker. Swap is contained behind a single email-sending module.

✅ **Scheduling infrastructure for reconcile job:** ADR-0012 says "Fly.io Machines/cron-equivalent"; exact scheduling mechanism (Fly Cron, trigger-based Machine, etc.) is Fly.io-specific implementation detail for Phase 1.

✅ **Privacy officer designation:** ADR-0015 requires the Foundation to name a specific person; this is an org decision, not a code/schema decision, recorded as a prerequisite for Phase 10.

### Verdict

**Yes, this document set is sufficient to build a production-ready commercial-grade system.**

Every decision necessary to write Phase 1 code has an accepted ADR with rationale and phase-gate implications. Every product ambiguity (event-hours semantics, account-linking policy, breach-notification ownership) has been resolved and documented. Every known risk (Rust CRUD immaturity, hand-rolled auth, two-language stack, PDF/UA-1 validation, hiring costs) is explicit, not hidden.

The one cross-document reconciliation that happened during planning (ADR-0006 amended after DDD modeling surfaced the event-lead-hours case) demonstrates that these documents are not just individually plausible — they are internally consistent and actively validated against each other.

**Phase 0 (Architecture Decisions) is complete.** All decisions in build-roadmap.md's Phase 0 gate have an accepted ADR. **Phase 1 (Foundation) can begin.**

---

## How to use this documentation

1. **For implementation:** Start with the ADRs in reading order (0001–0016). Each ADR's "Phase Gate" section lists what it unblocks. When implementing a phase, verify every exit criterion in build-roadmap.md against the corresponding ADRs.

2. **For code review:** Use the DDD files as the specification for aggregate invariants, repository ports, and domain event shapes. Use the ADRs as the specification for security boundaries (auth extractors, RLS patterns, audit logging).

3. **For team onboarding:** Read concept.md for the product vision, research-findings.md and rust-stack-research.md for the "why each choice was made," ADR-0001 for the per-component language decision table, and the relevant DDD context file for the code you're working on.

4. **For compliance review:** The full PIPEDA/GDPR/WCAG surface is documented across three places: `concept.md` section 9 (original requirements), ADRs 0014–0015 (decisions), and `build-roadmap.md` Phase 10 (implementation gates). No compliance requirement appears in only one place.

5. **For future decisions:** If you need to change something, check if an ADR already exists for it. If so, read the "Alternatives Considered" section — the research is already documented. If not, follow the ADR format (status, context, decision, consequences, alternatives, phase gate) and link to the ADR it supersedes.

---

**Last updated:** 2026-08-19
**Status:** Phase 0 (Architecture Decisions) complete. Phase 1 can begin.
