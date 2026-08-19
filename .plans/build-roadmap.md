# Agentics Foundation Volunteer Portal — Build Roadmap

Status snapshot. Source of truth for phase sequencing and exit criteria across
multi-session implementation. Derived from `concept.md` section 11 (Build
Sequence) and the blocking gaps in `research-findings.md`. Adapted for the
**Rust-first architecture pivot**: implementation must use Rust wherever
viable; TypeScript only where Rust doesn't work; other languages as a last
resort. Concrete Rust stack choices (web framework, frontend language, ORM,
hosting) are tracked separately by the Rust stack research pass and consumed
as inputs to Phase 0 below — this document works at the phase/milestone
level and does not pin those specifics.

This is sequencing and exit-criteria work. It does not add product scope
beyond what's in `concept.md`.

**Last updated:** 2026-08-19
**Overall status:** Phase 0 not started — no schema or application code exists yet.

---

## How to read this document

Each phase has:
- **Depends on** — phases/decisions that must be resolved first.
- **Scope** — what gets built, taken from concept.md section 11.
- **Exit criteria** — the bar for "production-ready," not "scaffolded." A
  phase is not done until every exit criterion is checked, including the
  compliance/audit gates inherited from `research-findings.md`.
- **Status** — `not started` / `in progress` / `blocked` / `done`.

Phases 1-4 together constitute the first usable portal milestone (per
concept.md). Phase 9 (semantic matching) is an explicit differentiator, not
part of the deterministic core, and must not be attempted before Phases 1-8
are stable.

---

## Phase 0 — Architecture Decisions (gate)

**Status: not started — blocks all other phases.**

No schema or application code should be written until every decision below
is resolved via an accepted ADR. This phase did not exist in concept.md's
original sequence; it is inserted because research-findings.md identified
concrete decisions that block Build Sequence step 1, and the Rust pivot adds
further decisions of the same kind.

**Depends on:** the parallel Rust-stack research pass (web framework,
frontend language, ORM, hosting split, Discord crate ecosystem maturity,
PDF/vector library availability in Rust).

**Decisions to resolve (each needs an accepted ADR):**

- [ ] Database provider and access-control model — Supabase+RLS (policy logic
  in the database) vs. Neon+application-layer authorization (policy logic in
  the Rust service). Affects schema design and where the security boundary
  lives.
- [ ] Rust web framework, ORM/query layer, and frontend language/framework
  (Rust-first: e.g. server-rendered Rust vs. a Rust-to-Wasm frontend vs. a
  TypeScript frontend as the sanctioned exception). This is the concrete
  output of the parallel Rust-stack research pass.
- [ ] Hosting split — where the Rust service, scheduled/cron jobs, and any
  TypeScript exception components each run. Determines feasibility of the
  Discord reconcile job and PDF rendering deployment models.
- [ ] Account-linking policy for Discord + Google login to the same
  volunteer identity — automatic (email-based) or manual (explicit user
  confirmation). Auth flows are unsafe by default if auto-linking is enabled
  without documented email-verification guarantees.
- [ ] Email provider — Resend vs. Postmark (or a Rust-compatible alternative
  if the chosen provider's SDK quality differs by language).
- [ ] PDF library and PDF/UA (ISO 14289) tagging support — must be resolved
  in a Rust-capable or sanctioned-exception library before Phase 6 starts.
- [ ] Schema addition: **AuditLog** table (actor, action, entity_type,
  entity_id, before/after snapshot, timestamp) — the four-object model in
  concept.md is incomplete against its own section 9 compliance floor. Decide
  now whether a `ProjectLead` join table (co-lead support) is added at the
  same time, since it is cheap now and expensive to retrofit.
- [ ] Event-to-HourEntry semantics — do event (meetup) attendances accrue
  verification-letter-eligible hours? This is a binary product decision with
  schema consequences (approval model if yes; a hard constraint preventing
  HourEntry against event-type Assignments if no). Resolve the underlying
  Assignment polymorphism as a single typed model (recommended: `Project`
  with a `type` discriminator) rather than dual nullable FKs.
- [ ] GDPR Art. 27 EU representative — designate one, or document why the
  "occasional, small-scale, low-risk" exemption applies.
- [ ] Breach notification process and privacy officer designation (PIPEDA) —
  documented incident-response procedure and a named accountable person.
- [ ] Plugin/tooling installation mechanism documentation (ruflo-* via
  Claude Code plugin marketplace, not npm) — non-blocking for architecture,
  but should be corrected in build docs before other agents rely on the
  concept.md text literally.

**Exit criteria:**
- Every decision above has an accepted ADR (not just a Slack-message-style
  decision — recorded, dated, rationale included).
- The five-plus-table schema (Volunteer, Project, Assignment, HourEntry,
  AuditLog, optionally ProjectLead) is drafted and reflects the resolved
  Assignment/event model.
- The Rust/TypeScript split is stated per-component, not just "mostly Rust"
  — i.e., a table of {component: language, rationale} exists.
- Nothing in Foundation is blocked on an open question.

---

## Phase 1 — Foundation

**Depends on:** Phase 0 (DB/RLS model, Rust framework, hosting split).

**Scope:** Rust backend scaffold, Postgres schema for all core objects
(including AuditLog), Discord OAuth, role model (`volunteer`/`lead`/`admin`).

**Exit criteria:**
- Role-based authorization is enforced **server-side** on every mutating
  endpoint — never only in UI or middleware (CVE-2025-29927 is the concrete
  cautionary case: middleware-only auth is bypassable).
- Schema migrations are reproducible from a clean database.
- AuditLog writes are wired at the framework level so every subsequent
  phase's mutations land there by construction, not by each phase
  remembering to call it.
- Discord OAuth login round-trips to a real Discord app in a dev environment.
- CI runs build + migrations + a smoke test on every change.

---

## Phase 2 — Onboarding

**Depends on:** Phase 1; Phase 0's account-linking ADR.

**Scope:** signup form (name, email, Discord handle, timezone, skills,
availability), code-of-conduct acceptance, contribution/IP agreement, age
attestation (18+), admin approval.

**Exit criteria:**
- Account-linking policy from Phase 0 is implemented and has a test proving
  the unsafe case (auto-link without verification) cannot happen.
- Agreement acceptances (code of conduct, IP agreement, age attestation) are
  stored with timestamps and are queryable per volunteer.
- Admin approval action writes an AuditLog entry.
- WCAG 2.1 AA: automated (axe-core in CI) **and** manual (keyboard-only
  navigation, one screen reader pass) testing completed on the signup flow
  specifically — automated tooling alone (~30% of success criteria) is not
  sufficient to call this phase done.

---

## Phase 3 — Projects

**Depends on:** Phase 1; Phase 0's Assignment/event model decision.

**Scope:** project directory filterable by skill, apply-to-project flow with
lead approval, lead view (applicants, roster, remove/reassign), event
signup as the secondary assignment path.

**Exit criteria:**
- Lead-scoped authorization enforced server-side: a lead can only act on
  projects where they are the lead (or, if ProjectLead join table was added,
  where they are one of the leads).
- Roster changes (add/remove/reassign) write AuditLog entries.
- WCAG 2.1 AA automated + manual pass on directory, apply flow, and lead
  roster views.

---

## Phase 4 — Hours

**Depends on:** Phase 3; Phase 0's event-hours semantics ADR.

**Scope:** self-logged hour entry against an assignment, lead approval queue
with bulk approve, cumulative totals per volunteer and per project.

**Exit criteria:**
- Approval actions are lead-scoped and enforced server-side, matching Phase
  3's model.
- Manual hour adjustments write AuditLog entries with before/after values
  (concept.md section 8 requires this explicitly).
- Event-hours behavior matches the Phase 0 ADR and is enforced at the
  application/schema boundary, not just in UI copy.
- WCAG 2.1 AA automated + manual pass on entry and approval-queue flows.

**Milestone: Phases 1-4 complete = first usable portal**, matching
concept.md's own framing ("Steps 1 through 4 constitute a usable portal").

---

## Phase 5 — Discord bot

**Depends on:** Phase 1 (role model); Phase 0's hosting-split decision; the
Rust-stack research pass's finding on Discord crate maturity (`serenity` /
`twilight` or equivalent) — if the Rust Discord ecosystem cannot cover
scheduled REST reconciliation and slash-command interactions adequately,
this is a candidate for the sanctioned TypeScript exception, and that must
be decided explicitly in Phase 0, not discovered mid-build.

**Scope:** role-sync bot as a scheduled reconcile job (not real-time
Gateway/webhooks), notifications (DM/channel), account linking via OAuth at
signup plus a `/link` command for Discord-first joiners.

**Exit criteria:**
- Reconcile job is idempotent and self-heals after simulated downtime
  (tested: manually desync roles, run job, confirm correction).
- `/link` command tested end-to-end against a real Discord app in a dev
  guild.
- Notification delivery failure is handled (logged/retried), not silently
  dropped.
- No persistent always-on Gateway bot process introduced — reconcile via
  REST + Vercel-Cron-equivalent scheduling only, per research-findings.md's
  explicit recommendation.

---

## Phase 6 — Verification Letters

**Depends on:** Phase 4 (approved HourEntry data); Phase 0's PDF
library/PDF-UA decision.

**Scope:** PDF generation from approved hours only, rendered on demand and
never stored, Foundation letterhead, date range, total hours, project
names, admin signature, volunteer-triggered generation.

**Exit criteria:**
- PDF/UA (ISO 14289) tagging is either confirmed supported by the chosen
  library and enabled, or a documented alternative accessibility approach
  is in place — this must be resolved, not left as a known gap, before this
  phase ships (research-findings.md flags this as currently unaddressed).
- Letters are provably generated only from `approved` HourEntry rows (test
  covers: pending/rejected hours never appear).
- Brand compliance verified: colors (`#faf8f3`, `#ff5a1f`, `#1a2a3a`,
  `#5cb8e8`), no palette substitutions, no em/en dashes in copy.
- No generated letter is persisted to storage — regenerated on each request
  from source data.

---

## Phase 7 — Email

**Depends on:** Phase 0's email provider decision; triggers depend on the
event they fire from (signup → Phase 2, assignment/hours approved → Phases
3/4, verification letter ready → Phase 6).

**Scope:** brand-system templates wired to the five transactional triggers
(signup confirmation, assignment approved, hours approved, meeting
reminder, verification letter ready).

**Exit criteria:**
- All five triggers tested end-to-end against the real provider in a dev/
  sandbox environment (not just template rendering in isolation).
- Brand system compliance verified on every template.
- Delivery failure handling defined (what happens if the provider call
  fails — retry, log, alert).

---

## Phase 8 — Admin

**Depends on:** Phase 1 (AuditLog exists); Phases 3-4 (data to report on).

**Scope:** roster with filters and CSV export, hours report by project and
date range, manual hour adjustment with visible audit trail.

**Exit criteria:**
- Every admin mutating action in this phase (roster edits, manual
  adjustments) is verified via a coverage test to produce an AuditLog entry
  — this closes the research-findings.md gap that flagged AuditLog as
  missing from the original four-object model. This is a blocking gate:
  the phase is not done if any admin mutation path is unaudited.
- CSV export tested against a non-trivial dataset (pagination/large roster).
- Hours report totals verified to match source HourEntry data exactly
  (reconciliation test).

---

## Phase 9 — Semantic matching (differentiator, not core)

**Depends on:** Phases 1-8 stable; Rust-stack research pass's finding on
whether a Rust-native vector/embedding library is viable, or whether
`ruvector` (npm-only) is used as the sanctioned TypeScript exception for
this specific layer.

**Scope:** vector-based matching layer over free-text skills and project
descriptions — surfaces relevant projects and suggests which open project a
returning volunteer should log hours against. Everything else in the portal
remains deterministic SQL.

**Exit criteria:**
- Matching quality validated against a labeled test set of realistic skill
  descriptions (not just "it returns something").
- Deterministic SQL directory search/filter remains available and is not
  replaced — the vector layer is additive.
- No cross-project or cross-volunteer data leakage introduced by the
  matching layer (e.g. suggesting a volunteer to a project whose applicant
  list they shouldn't see).

**Must not be attempted before Phases 1-8 are stable**, per concept.md's own
sequencing note.

---

## Phase 10 — Compliance hardening

**Depends on:** all prior phases (this is a full-surface audit, not new
feature work); Phase 0's GDPR/PIPEDA decisions.

**Scope:** full accessibility audit, privacy policy, retention and deletion
paths, breach notification process execution, encryption/backup
verification.

**Exit criteria:**
- Full-site WCAG 2.1 AA audit — automated (axe-core) **and** manual
  (keyboard-only + at least one screen reader: NVDA/JAWS/VoiceOver) —
  covering every flow built in Phases 2-9, documented with results per page/
  flow. This is in addition to, not a replacement for, the per-phase WCAG
  gates already required in Phases 2-4.
- Privacy policy published with a stated retention period.
- Deletion request path functional end-to-end (a request results in actual
  data removal or documented anonymization, verified by test).
- Breach notification runbook documented, with a named privacy officer
  accountable for PIPEDA's "real risk of significant harm" reporting
  obligation to the OPC and affected individuals.
- GDPR Art. 27 decision from Phase 0 is executed: EU representative
  designated, or the occasional-processing exemption rationale is published.
- Encryption-at-rest and automated backups are not just configured but
  **restore-tested** (a backup has been restored at least once and
  verified).

---

## Cross-phase dependency summary

| Phase | Hard dependency | Why |
|---|---|---|
| 1 Foundation | 0 | DB/RLS model and Rust framework must be chosen before schema/scaffold |
| 2 Onboarding | 0 (account-linking), 1 | Auth flow correctness |
| 3 Projects | 0 (event/assignment model), 1 | Schema shape for Assignment |
| 4 Hours | 0 (event-hours semantics), 3 | Approval scoping reuses lead-scoping from Projects |
| 5 Discord bot | 0 (hosting split, Discord crate maturity), 1 | Reconcile job needs a scheduled-job host and a role model |
| 6 Verification letters | 0 (PDF library/PDF-UA), 4 | Renders from approved HourEntry rows |
| 7 Email | 0 (provider), 2/3/4/6 | Triggers fire from events in those phases |
| 8 Admin | 1 (AuditLog), 3, 4 | Reports on project/hours data, audits admin actions |
| 9 Semantic matching | 0 (Rust vs TS exception for vector layer), 1-8 stable | Explicit differentiator, not core |
| 10 Compliance hardening | 0 (GDPR/PIPEDA decisions), all prior | Full-surface audit |

---

## Tracking

This file is the human-readable snapshot. Phase status is also tracked in
this session's agent memory (`horizon` entry) for drift detection across
future sessions — check both if they disagree, this file wins as the
checked-in source of truth.
