# Implementation Prompts — Agentics Foundation Volunteer Portal

Each prompt below is self-contained and meant to be handed verbatim to an
implementation agent, in order. They are derived from, and explicitly cite,
the accepted ADRs in `.plans/adrs/` and the domain model in `.plans/ddd/`.
Do not reopen a decision an ADR already made — if a prompt's output seems to
require reopening one, stop and flag it rather than silently deciding
differently (see the ADR-0006 amendment in this project's own history for
why: a real conflict between accepted docs was caught and reconciled before
it caused implementation drift, not after).

## Non-negotiable constraint, repeated in every prompt on purpose

**This project is Rust as much as possible. TypeScript only where an
accepted ADR explicitly sanctions it as an exception, nothing else.** Per
[ADR-0001](adrs/0001-language-and-stack-strategy.md), there are exactly
**two** sanctioned TypeScript exceptions in the entire system:

1. The frontend web UI — [ADR-0011](adrs/0011-frontend-architecture-typescript-exception.md).
2. The Phase 9 semantic-matching layer (`ruvector`) — [ADR-0013](adrs/0013-semantic-matching-vector-layer.md).

Everything else — the backend API, all business logic, all data access, RLS
enforcement, Discord integration, PDF generation, email sending, the audit
framework — is Rust. If a prompt below is implementing anything outside
those two exceptions, the implementation is Rust. Do not introduce a third
language or a third exception without a new accepted ADR. Do not reach for
a Node/TypeScript library "for convenience" inside the Rust backend's scope
just because it would be faster to write — that is exactly the drift this
document exists to prevent.

## Reading order for context

Before starting **any** prompt, read `.plans/concept.md`,
`.plans/research-findings.md`, `.plans/build-roadmap.md`, and
`.plans/ddd/context-map.md`. Each prompt below additionally names the
specific ADRs and DDD files it draws from — read those too before writing
code for that prompt.

## How these map to build-roadmap.md

Prompts are grouped by the phase they belong to (build-roadmap.md's
Phase 0–10 numbering), broken into smaller, dependency-ordered units within
each phase where a phase covers more than one independently buildable
piece. A prompt is not "done" until its own exit criteria pass **and** the
exit criteria of its parent phase that it's responsible for are satisfied —
check build-roadmap.md's phase-level exit criteria in addition to the
per-prompt ones listed here.

---

## Phase 0 — Architecture Decisions

**No implementation prompt.** Phase 0 is complete: all 16 ADRs in
`.plans/adrs/` are accepted, and `.plans/ddd/` resolves the product-level
ambiguities the ADRs deferred to it (event-hours semantics). Every prompt
below builds on that closed decision set. Do not re-litigate a Phase 0
decision inside a Phase 1+ prompt — if new information suggests one is
wrong, that's a new ADR (following ADR-0006's amendment pattern: amend in
place with a dated "Amended" line, don't silently deviate in code).

---

## Phase 1 — Foundation

### Prompt 1.1 — Cargo workspace scaffold and `kernel` crate

**References:** [ADR-0001](adrs/0001-language-and-stack-strategy.md),
[ADR-0002](adrs/0002-backend-web-framework.md),
[context-map.md](ddd/context-map.md) (Cargo workspace structure section).

**Task:** Create the Cargo workspace exactly as laid out in
context-map.md's "Cargo workspace structure" section:

```
volunteer-portal/
  Cargo.toml                      # [workspace] members
  crates/
    kernel/
    identity-access/
    projects-assignments/
    hours-verification/
    discord-integration/
    notifications/
    compliance-audit/
  apps/
    api/
  migrations/
```

Implement the `kernel` crate first, since every other crate depends on it
per context-map.md's acyclic dependency graph
(`kernel ← identity-access ← { everything else } ← apps/api`). `kernel`
provides:
- `Id<T>` newtype wrapper for UUID-typed identifiers (`VolunteerId`,
  `ProjectId`, `AssignmentId`, `HourEntryId`, etc. — one per aggregate that
  will be defined in later prompts, but the generic wrapper goes here).
- The `DomainEvent` and `AuditableEvent` traits, and the `ActorId` enum
  (`Volunteer(VolunteerId) | System`), exactly as specified in
  context-map.md's domain-events section.
- Shared error types (`RepoError`, etc.).
- The RLS-safe scoped-transaction helper: `db.begin_scoped(user_id)`,
  implementing [ADR-0004](adrs/0004-orm-and-row-level-security.md)'s
  `SET LOCAL app.current_user_id = $1` pattern as a connection-acquisition
  wrapper. This must be the **only** way any repository in any later crate
  acquires a transaction — no repository trait implementation anywhere in
  this codebase may open its own unscoped connection.

Add Axum, SQLx, and Tokio as workspace dependencies now
([ADR-0002](adrs/0002-backend-web-framework.md),
[ADR-0004](adrs/0004-orm-and-row-level-security.md)); leave `apps/api`
itself minimal (a health-check route only) until Prompt 1.4.

**Exit criteria:** Workspace builds (`cargo check --workspace`). The
`begin_scoped` helper has an integration test (against a real Postgres —
see Prompt 1.2) proving that two concurrent scoped transactions with
different `user_id`s cannot see each other's `SET LOCAL` value, and that a
plain `SET` (not `SET LOCAL`) is not used anywhere in the helper's
implementation.

---

### Prompt 1.2 — Database schema and RLS

**References:** [ADR-0003](adrs/0003-database-provider.md),
[ADR-0004](adrs/0004-orm-and-row-level-security.md),
[ADR-0005](adrs/0005-audit-log-and-co-leads.md),
[ADR-0006](adrs/0006-assignment-event-model-and-hours-semantics.md) (as
amended), [identity-access.md](ddd/identity-access.md),
[projects-assignments.md](ddd/projects-assignments.md),
[hours-verification.md](ddd/hours-verification.md).

**Task:** Provision a Neon Postgres project and Neon branching for
CI/preview environments ([ADR-0003](adrs/0003-database-provider.md)).
Write the initial SQLx migration (`migrations/`) creating all **six**
core tables — concept.md's original four plus the two ADR-0005 added:

- `volunteer` — fields per `Volunteer` in
  [identity-access.md](ddd/identity-access.md): identity, email
  (unique), `discord_id` (nullable, unique when present), timezone,
  skills, availability, `status`, `role`, the three `Agreements`
  timestamp columns.
- `identity` — the OAuth-link table from
  [identity-access.md](ddd/identity-access.md)'s `OAuthLink`:
  `volunteer_id`, `provider`, `provider_user_id`, `email`,
  `email_verified`, `linked_at`. (Named `identity` in ADR-0007's context;
  reconcile the exact table name against
  [ADR-0007](adrs/0007-authentication-oauth-and-account-linking.md) before
  finalizing the migration.)
- `project` — with the `type` discriminator (`'project' | 'event'`) per
  the amended [ADR-0006](adrs/0006-assignment-event-model-and-hours-semantics.md)
  and [projects-assignments.md](ddd/projects-assignments.md)'s `Project`
  struct, including the nullable `EventSchedule` columns
  (`next_occurrence_at`, `recurrence_note`) used only when
  `type = 'event'`.
- `project_lead` — join table per
  [ADR-0005](adrs/0005-audit-log-and-co-leads.md): `(project_id,
  volunteer_id)` primary key, `role` column.
- `assignment` — including the **`participation_mode` column**
  (`'contributor' | 'attendee'`), set at insert time and never updated
  afterward (enforce immutability with a trigger or simply never expose an
  UPDATE path for this column at the application layer — this must match
  [projects-assignments.md](ddd/projects-assignments.md)'s
  `Assignment::apply` invariant exactly).
- `hour_entry` — per [hours-verification.md](ddd/hours-verification.md)'s
  `HourEntry`, including the `adjustment_*` columns for
  [ADR-0005](adrs/0005-audit-log-and-co-leads.md)'s audit-trail
  requirement.
- `audit_log` — exact columns per
  [ADR-0005](adrs/0005-audit-log-and-co-leads.md)'s table.

**RLS policies** on `project`, `project_lead`, `assignment`, `hour_entry`,
and `audit_log`, referencing `current_setting('app.current_user_id')`, per
[ADR-0004](adrs/0004-orm-and-row-level-security.md). Set
`FORCE ROW LEVEL SECURITY` on every one of these tables, and create the
application's database role as a **non-owner** role — this is the single
highest-priority security-review item named in ADR-0004; do not skip it or
defer it.

**The event-hours trigger:** per the amended
[ADR-0006](adrs/0006-assignment-event-model-and-hours-semantics.md), add a
Postgres trigger on `hour_entry` that joins through `assignment` and
rejects any insert where the referenced assignment's
`participation_mode <> 'contributor'`. This mirrors, and must never
diverge from, the application-layer invariant in
[hours-verification.md](ddd/hours-verification.md)'s `HourEntry::log`
(built in Prompt 4.1) — write both from the same source-of-truth
understanding of the rule, and add a test that inserts directly via SQL
(bypassing the Rust layer entirely) to prove the trigger alone blocks the
invalid case.

**Exit criteria (also closes build-roadmap.md's Phase 1 exit criteria
"schema migrations are reproducible from a clean database"):** `sqlx
migrate run` succeeds against a fresh Neon branch; the offline `.sqlx`
query cache is checked into the repo; CI runs migrations and integration
tests **as the non-owner application role**, not as the migration-owner
role, specifically to catch the RLS-bypass class ADR-0004 warns about.

---

### Prompt 1.3 — `identity-access` crate (Volunteer aggregate)

**References:** [identity-access.md](ddd/identity-access.md) in full.

**Task:** Implement the `Volunteer` aggregate, `Role`/`VolunteerStatus`
enums, `Agreements` value object, and `OAuthLink` exactly as specified in
identity-access.md, including all five invariants listed there (status
transitions require complete Agreements; email validity; role changes only
via explicit `change_role`; unique `discord_id`; suspended-volunteer
transition rules). Implement `VolunteerRepository` and the
`VolunteerSummaryQuery` read port against the `volunteer`/`identity` tables
from Prompt 1.2, using the caller-supplied scoped transaction from
`kernel::begin_scoped` exclusively.

Do **not** implement `link_additional_provider`'s full OAuth-handshake flow
yet (that needs Axum wiring — see Prompt 2.2) or the manual/automatic
linking policy decision beyond what identity-access.md already specifies
as its own recommendation; if
[ADR-0007](adrs/0007-authentication-oauth-and-account-linking.md) is not
yet reflected in identity-access.md by the time you implement this, follow
ADR-0007 as the authoritative source (it is the accepted decision;
identity-access.md's account-linking section frames itself explicitly as
"this document's input to that decision, not a claim it's already
settled" — ADR-0007 is now settled, use it).

Emit `VolunteerOnboarded`, `VolunteerApproved`, `OAuthAccountLinked`,
`RoleChanged` as specified, with correct `AuditableEvent` implementations.

**Exit criteria:** Unit tests for all five invariants (each one has at
least one test proving construction/mutation is refused when violated).
`cargo test -p identity-access` passes against a real Neon branch via the
scoped-transaction helper.

---

### Prompt 1.4 — Axum composition root, auth extractors, and audit-framework wiring

**References:** [ADR-0002](adrs/0002-backend-web-framework.md),
[ADR-0005](adrs/0005-audit-log-and-co-leads.md),
[context-map.md](ddd/context-map.md) (audit-capture mechanism, "1. Direct
calls" and "2a. Audit capture" sections).

**Task:** Build `apps/api`'s composition root: the Axum `Router`, and the
`AuthUser`/`LeadOf` extractors specified in
[ADR-0002](adrs/0002-backend-web-framework.md) (`LeadOf` depends on
`projects-assignments`'s `LeadMembershipQuery` port — stub this port for
now if `projects-assignments` isn't built yet, and wire the real
implementation in Prompt 3.2). Every mutating/admin handler added in any
future prompt **must** name one of these extractors in its function
signature — set up the custom lint pass or `cargo clippy` check named in
ADR-0002 now, so it catches violations from the first handler onward
rather than being retrofitted later.

Extend `kernel::begin_scoped` (from Prompt 1.1) into the full
framework-level audit mechanism per
[ADR-0005](adrs/0005-audit-log-and-co-leads.md) and
context-map.md's mechanism (a): the scoped-transaction helper, when a
handler's repository `.save()` call returns events, inspects each
`Box<dyn DomainEvent>` for the `AuditableEvent` trait and writes a row to
`audit_log` **in the same transaction** automatically. No handler anywhere
in this codebase should ever call an "insert into audit_log" function
directly — if a future prompt finds itself doing that, stop, that's a sign
this wiring is being bypassed.

**Exit criteria (closes build-roadmap.md's Phase 1 criterion "AuditLog
writes are wired at the framework level"):** A test handler that mutates
`Volunteer` (using Prompt 1.3's `VolunteerRepository`) and returns an
`AuditableEvent`-implementing event produces exactly one `audit_log` row
per mutation, with no application code outside the framework helper
touching `audit_log`. CI runs build + migrations + this smoke test on
every change (closes the remaining Phase 1 exit criterion).

---

### Prompt 1.5 — Discord OAuth login round-trip

**References:** [ADR-0007](adrs/0007-authentication-oauth-and-account-linking.md)
(libraries and session sections only — full account-linking policy is
Prompt 2.2), [ADR-0012](adrs/0012-hosting-and-deployment-topology.md)
(subdomain/cookie architecture).

**Task:** Implement the Discord OAuth2 login flow using the `oauth2` crate
per ADR-0007, and `tower-sessions` with a Postgres session store (same
Neon database, per ADR-0007's "avoiding a separate Redis dependency for
v1"). Wire session cookies per
[ADR-0012](adrs/0012-hosting-and-deployment-topology.md)'s
same-parent-domain subdomain architecture
(`Domain=.example.org`) even if the actual frontend/backend split isn't
deployed yet — get the cookie scoping right from the start rather than
retrofitting it once a cross-subdomain bug appears. On successful OAuth
callback with no existing `identity` row, create a new `Volunteer` via
`Volunteer::signup` (Prompt 1.3).

Do not implement Google OAuth or the manual-linking flow yet — that is
[ADR-0007](adrs/0007-authentication-oauth-and-account-linking.md)'s full
scope, built in Prompt 2.2 alongside onboarding, since concept.md frames
Google as "fallback" and the Phase 1 exit criterion only requires the
Discord round-trip.

**Exit criteria (closes build-roadmap.md's Phase 1 criterion "Discord
OAuth login round-trips to a real Discord app in a dev environment"):**
Manual or automated test against a real Discord OAuth app in a dev guild
completes a login round-trip and results in a session cookie scoped
correctly for the chosen subdomain architecture.

**Phase 1 is complete when Prompts 1.1–1.5 all pass their exit criteria
and build-roadmap.md's full Phase 1 exit-criteria list is satisfied.**

---

## Phase 2 — Onboarding

**Depends on:** Phase 1 complete; frontend scaffold begins here (first
prompt needing [ADR-0011](adrs/0011-frontend-architecture-typescript-exception.md)'s
TypeScript exception).

### Prompt 2.1 — Frontend scaffold and generated API types

**References:** [ADR-0011](adrs/0011-frontend-architecture-typescript-exception.md)
in full.

**Task:** Scaffold the TypeScript frontend (Next.js or SvelteKit — per
ADR-0011, "either is acceptable ... a Phase 1 implementation detail," so
pick one and record the pick, don't leave it ambiguous going forward).
This is the **first** of the two sanctioned TypeScript exceptions — do not
let this prompt's scope creep into re-implementing backend logic in
TypeScript; this crate/app only renders UI and calls the Rust API.

Set up `ts-rs` or `specta` ([ADR-0011](adrs/0011-frontend-architecture-typescript-exception.md)'s
named tools) to generate TypeScript types from the Rust request/response
types defined so far (Prompt 1.3's `Volunteer`-adjacent DTOs, Prompt 1.5's
session/auth types), wired into both build pipelines so a Rust type change
that isn't reflected in frontend usage fails to type-check. Set up the
accessible-component library decision this ADR's rationale depends on
(Radix UI or React Aria, if Next.js was picked; the SvelteKit equivalent
otherwise) — this is the whole reason ADR-0011 exists, so do not skip
installing and configuring it now.

**Exit criteria:** Frontend build succeeds and type-checks against
generated types from the current Rust API surface. A trivial page renders
using the chosen accessible-component library (proves the toolchain
works) before any real onboarding UI is built in Prompt 2.3.

---

### Prompt 2.2 — Account-linking policy implementation

**References:** [ADR-0007](adrs/0007-authentication-oauth-and-account-linking.md)
in full, [identity-access.md](ddd/identity-access.md) (OAuth linking
section).

**Task:** Implement Google OAuth via the `openidconnect` crate
(ID-token verification: JWKS fetch/cache, `aud`/`iss`/`exp` validation —
named explicitly in ADR-0007 as a Phase 1/2 security-review priority, do
not skip claims validation). Implement the full manual account-linking
flow per ADR-0007's decision: on a new-provider login matching an existing
verified-email `identity`, do **not** auto-link — surface the explicit
"sign in with your other provider, then link from account settings"
prompt, and implement `Volunteer::link_additional_provider` (Prompt 1.3's
stub, if not already fleshed out) requiring an authenticated session for
the *existing* account before the second provider is attached.

**Exit criteria (closes build-roadmap.md's Phase 2 criterion "account-linking
policy from Phase 0 is implemented and has a test proving the unsafe case
cannot happen"):** An integration test proves that an attacker controlling
a same-email account on the second provider **cannot** merge into a
victim's account without first being authenticated as the victim — assert
this explicitly, not just that the happy path works.

---

### Prompt 2.3 — Signup flow, agreements, and admin approval

**References:** concept.md section 3, [identity-access.md](ddd/identity-access.md)
(`Agreements` value object and invariant 1).

**Task:** Build the signup form (name, email, Discord handle, timezone,
skills, availability) as specified in concept.md section 3, plus code-of-
conduct acceptance, contribution/IP agreement, and age attestation (18+),
each stored with a timestamp per `Agreements`. Add the **country/region
field** [ADR-0014](adrs/0014-gdpr-article-27-representative.md) flags as a
required Phase 2 addition (needed to make its EU-volunteer-count trigger
monitorable later — do not skip this because ADR-0014's own phase gate is
nominally Phase 10; the field must exist on the signup form now or Phase
10 has no historical data to check). Build the admin-approval action,
which must go through Prompt 1.4's `AuthUser`/`AdminUser`-extractor-gated
handler pattern and therefore automatically produces an `audit_log` entry
via the framework wiring — do not write a separate manual audit call for
this action.

**Exit criteria (closes remaining build-roadmap.md Phase 2 criteria):**
Agreement acceptances are stored with timestamps and queryable per
volunteer. Admin approval writes exactly one AuditLog entry (verified by
test, not just by inspection). **WCAG 2.1 AA: both automated (axe-core in
CI) and manual (keyboard-only navigation, one screen reader pass) testing
completed on the signup flow specifically** — per build-roadmap.md's
explicit note that automated tooling alone (~30% of success criteria) is
not sufficient to call this phase done. Do not mark this prompt complete
on automated results alone.

**Phase 2 is complete when Prompts 2.1–2.3 all pass and build-roadmap.md's
full Phase 2 exit-criteria list is satisfied.**

---

## Phase 3 — Projects

### Prompt 3.1 — `projects-assignments` crate: `Project` aggregate

**References:** [projects-assignments.md](ddd/projects-assignments.md)
("Aggregate: `Project`" section and its invariants),
[ADR-0006](adrs/0006-assignment-event-model-and-hours-semantics.md) (as
amended).

**Task:** Implement `Project`, `ProjectType`, `ProjectStatus`,
`ProjectLead`, and `EventSchedule` exactly per
projects-assignments.md, including all five invariants (at-least-one-lead;
immutable `project_type`; only-Open-accepts-assignments; name/skills
validation; `schedule` present iff `project_type == Event`). Implement
`ProjectRepository` (including `find_open_by_skill` for directory
browsing and `find_led_by` backing the `LeadOf` extractor stubbed in
Prompt 1.4 — wire the real implementation into that extractor now) and the
`LeadMembershipQuery` port. Emit `ProjectCreated`, `ProjectLeadAdded`,
`ProjectLeadRemoved`, `ProjectClosed` with correct `AuditableEvent`
implementations.

Also implement the `UpcomingEventOccurrencesQuery` port specified in both
projects-assignments.md and (as a heads-up from) notifications.md — this
is needed by Phase 7's meeting-reminder trigger later, but belongs to this
crate/aggregate, so build it now while you're already implementing
`Project`'s event-schedule fields rather than retrofitting it in Phase 7.

**Exit criteria:** Unit tests for all five `Project` invariants. Integration
test proving `LeadMembershipQuery` correctly reflects `project_lead`
membership including the co-lead case (two leads on one project, both
pass, a non-lead fails).

---

### Prompt 3.2 — `Assignment` aggregate and the event-hours invariant

**References:** [projects-assignments.md](ddd/projects-assignments.md)
("Aggregate: `Assignment`" section, especially "The event-hours invariant,
enforced at construction"), the amended
[ADR-0006](adrs/0006-assignment-event-model-and-hours-semantics.md).

**Task:** Implement `Assignment`, `ParticipationMode`, `AssignmentStatus`,
and the `Assignment::apply` constructor **exactly** as specified in
projects-assignments.md's code block — this is the single point where the
event-hours rule is enforced (per ADR-0006's amendment, do not
reintroduce a separate `project_type` check anywhere else in the codebase;
every downstream consumer must rely on `participation_mode` alone).
Implement the apply → approve → active → removed/reassigned lifecycle and
its invariants (only `Applied` transitions to `Approved`/`Removed`;
`decided_by` must be a current lead per `LeadMembershipQuery`;
reassignment creates a new `Assignment` rather than mutating the old one).
Implement `AssignmentRepository`.

**Exit criteria (closes build-roadmap.md's Phase 3 criterion "lead-scoped
authorization enforced server-side"):** A test proves a non-lead cannot
approve/remove an assignment for a project they don't lead, even via a
crafted request bypassing the UI. A test proves `participation_mode` is
computed correctly for all three cases in projects-assignments.md's table
(project-type always Contributor; event-type lead is Contributor;
event-type non-lead is Attendee), and that it does not change if the
volunteer is promoted to lead after the assignment already exists.

---

### Prompt 3.3 — Project directory, apply flow, and lead roster UI

**References:** concept.md section 4, Prompts 3.1–3.2's endpoints.

**Task:** Build the project directory (filterable by skill, using
`find_open_by_skill`), the apply-to-project flow, and the lead view
(applicants, current roster, remove/reassign), plus event signup as the
secondary assignment path. Every roster-mutating action must go through
the `LeadOf` extractor.

**Exit criteria (closes remaining build-roadmap.md Phase 3 criteria):**
Roster changes (add/remove/reassign) write AuditLog entries (verified by
test). WCAG 2.1 AA automated + manual pass on directory, apply flow, and
lead roster views.

**Phase 3 is complete when Prompts 3.1–3.3 all pass and build-roadmap.md's
full Phase 3 exit-criteria list is satisfied.**

---

## Phase 4 — Hours

### Prompt 4.1 — `hours-verification` crate: `HourEntry` aggregate

**References:** [hours-verification.md](ddd/hours-verification.md) in
full, the amended [ADR-0006](adrs/0006-assignment-event-model-and-hours-semantics.md).

**Task:** Implement `HourEntry`, `HourEntryStatus`, the `Hours` value
object (using `rust_decimal`, per hours-verification.md's explicit
rationale — never `f64` for a value that feeds legal/compliance-facing
totals), `Adjustment`, and the `HourEntry::log` constructor **exactly** as
specified, including its refusal to build against any
non-`Contributor`-mode `AssignmentSnapshot` — this is the other half of
the event-hours invariant Prompt 3.2 started; both halves must agree, and
if they don't, that's a bug to fix here, not a reason to relax either
side. Implement `AssignmentSnapshotQuery` consumption (implemented by
`projects-assignments`, per the direct-call mechanism — do not
reimplement `participation_mode` logic in this crate). Implement
`HourEntryRepository` including `find_pending_for_lead` and
`find_approved_by_volunteer_and_range` (the latter feeds Prompt 6.1's
`VerificationLetterService`). Emit `HoursLogged`, `HoursApproved`,
`HoursRejected`, `HoursAdjusted` with correct `AuditableEvent`
implementations — `HoursAdjusted` must carry explicit before/after
`Hours` values, not a generic diff, per hours-verification.md's rationale.

**Exit criteria:** A test attempts to construct an `HourEntry` against an
`Attendee`-mode assignment snapshot and asserts it is refused with
`HourEntryError::AssignmentNotEligibleForHours`. A test constructs one
against a `Contributor`-mode event-lead assignment and asserts it
succeeds — both directions of Prompt 1.2's trigger and this constructor
must agree; add a test that inserts via raw SQL bypassing this
constructor and confirms the Prompt 1.2 trigger independently blocks the
same invalid case (defense-in-depth, verified both ways).

---

### Prompt 4.2 — Approval queue, bulk approve, and manual adjustment

**References:** concept.md section 5 and 8, [hours-verification.md](ddd/hours-verification.md)
("Other invariants" section).

**Task:** Build the lead approval queue with bulk approve (re-checking
`LeadMembershipQuery` per entry for the bulk case, since a single-project
`LeadOf` extractor doesn't cover a batch spanning multiple projects — per
hours-verification.md's explicit note) and cumulative totals per
volunteer and per project. Build the admin-only manual adjustment action
(admin scope, not lead — per concept.md section 8 and
hours-verification.md's invariant that `Adjustment` requires a non-empty
`reason` and admin-only access).

**Exit criteria (closes remaining build-roadmap.md Phase 4 criteria):**
Approval actions are lead-scoped and enforced server-side. Manual
adjustments write AuditLog entries with before/after values (test
verifies the specific `HoursAdjusted` shape, not just that *an* audit row
exists). Event-hours behavior is enforced at the application/schema
boundary (already covered by Prompt 4.1's tests — re-verify at the API
layer here, e.g. that the hours-entry endpoint itself returns a clean 4xx
for the ineligible case, not a 500). WCAG 2.1 AA automated + manual pass
on entry and approval-queue flows.

**Phase 4 is complete when Prompts 4.1–4.2 both pass and build-roadmap.md's
full Phase 4 exit-criteria list is satisfied. Per build-roadmap.md: Phases
1–4 together are the first usable portal milestone.**

---

## Phase 5 — Discord bot

### Prompt 5.1 — `discord-integration` crate: ACL types and `RoleReconciler`

**References:** [ADR-0008](adrs/0008-discord-integration-architecture.md)
in full, [discord-integration.md](ddd/discord-integration.md) ("The ACL
boundary" and "Domain service: `RoleReconciler`" sections).

**Task:** Implement the ACL vocabulary (`VolunteerFacingRole`,
`DesiredRoleSet`, `DiscordRoleMapping`, `DiscordRoleId`) with the hard
rule from discord-integration.md: **no `twilight_model` type crosses out
of the `infra` submodule** into any domain function signature, port
trait, or domain event. Implement `RoleReconciler` and its dependency
ports (`ApprovedVolunteersQuery` — implemented by `identity-access`;
`ActiveProjectMembershipQuery` — implemented by `projects-assignments`,
explicitly filtering to `Contributor`-mode assignments only, reusing
Prompt 3.2's `participation_mode` guarantee rather than re-deriving
event-hours logic here). Implement the `infra` layer against
`twilight-http`/`twilight-model` per
[ADR-0008](adrs/0008-discord-integration-architecture.md) — **not**
`serenity`. Deploy the reconcile job as a scheduled job on Fly.io per
[ADR-0012](adrs/0012-hosting-and-deployment-topology.md).

**Exit criteria (closes build-roadmap.md's Phase 5 criterion "reconcile
job is idempotent and self-heals"):** A test manually desyncs a role in a
dev Discord guild, runs the reconcile job, and confirms the correction —
per discord-integration.md's "Idempotency / self-healing" section, this
must work because `reconcile()` always diffs against a **live** read of
Discord's actual state, never a cached "what we last set" record; the
test should specifically prove there is no such cache being consulted.

---

### Prompt 5.2 — `/link` interaction handler and DM notification sender

**References:** [ADR-0008](adrs/0008-discord-integration-architecture.md)
("`/link` command" and "Notifications" bullets),
[discord-integration.md](ddd/discord-integration.md) ("Application
service: `/link` command handling" and "Failure handling" sections).

**Task:** Implement the Axum HTTP endpoint receiving Discord interaction
webhooks, verifying the `X-Signature-Ed25519`/`X-Signature-Timestamp`
headers via `ed25519-dalek` against Discord's documented test vectors
**before** any payload parsing happens — per ADR-0008, this signature
check is required regardless of Discord crate choice and must be
implemented once, correctly, and tested against those vectors. Implement
`LinkCommandHandler`, calling into `identity-access`'s
`VolunteerLinkingPort` (Prompt 2.2's manual-linking flow) — this context
identifies the Discord-side actor and hands off the linking decision, it
does not decide linking policy itself. Implement `DiscordNotificationSender`
(the `send_dm` port) per discord-integration.md, as one implementation of
whichever channel-delivery port `notifications.md` defines (built in
Prompt 7.1) — coordinate with that prompt's port shape rather than
guessing it independently.

**Exit criteria (closes remaining build-roadmap.md Phase 5 criteria):**
`/link` command tested end-to-end against a real Discord app in a dev
guild. Notification delivery failure is handled (logged/retried via
Prompt 7.1's `NotificationAttempt` mechanism), not silently dropped. No
persistent always-on Gateway bot process is introduced anywhere in this
codebase — reconcile and `/link` are REST/HTTP-interactions only, per
concept.md and ADR-0008.

**Phase 5 is complete when Prompts 5.1–5.2 both pass and build-roadmap.md's
full Phase 5 exit-criteria list is satisfied.**

---

## Phase 6 — Verification Letters

### Prompt 6.1 — `VerificationLetterService` and Typst rendering

**References:** [ADR-0009](adrs/0009-verification-letter-pdf-generation.md)
in full, [hours-verification.md](ddd/hours-verification.md)
("Verification letters: a process, not a stored entity" section).

**Task:** Implement `VerificationLetterDraft` and
`VerificationLetterService::draft` exactly as specified in
hours-verification.md — a read-only rollup over
`find_approved_by_volunteer_and_range` (Prompt 4.1), with **no**
`VerificationLetter` aggregate, entity, or table, per concept.md's
"rendered on demand... never stored" requirement. Because `HourEntry` can
only exist for `Contributor`-mode assignments (Prompt 4.1's invariant),
this service needs no event-type filtering of its own — do not add any.
Build the Typst letterhead template (brand colors per concept.md section
7: cream `#faf8f3`, orange `#ff5a1f`, navy `#1a2a3a`, cyan `#5cb8e8`; no
palette substitutions; no em/en dashes in any copy, including this
template's own static text) and the `infra`-layer renderer using the
`typst` crate, `typst-as-lib`, and `typst-pdf`
([ADR-0009](adrs/0009-verification-letter-pdf-generation.md)), compiling
to a **PDF/UA-1 tagged PDF** (`--pdf-standard ua-1`) and streaming it
directly in the HTTP response — never to disk or object storage.

**Exit criteria (closes build-roadmap.md's Phase 6 criteria in full):**
The generated PDF is validated against a real PDF/UA conformance checker
(e.g. veraPDF) — per ADR-0009, do not trust the `--pdf-standard ua-1` flag
existing as sufficient proof; this validation is a named, non-negotiable
gate. A test proves letters are generated only from `approved` HourEntry
rows (pending/rejected hours never appear). Brand compliance verified
against the exact colors and no-em/en-dash rule. A test proves no letter
is ever persisted (e.g. assert no write to any storage/filesystem/table
occurs during generation).

**Phase 6 is complete when Prompt 6.1 passes and build-roadmap.md's full
Phase 6 exit-criteria list is satisfied.**

---

## Phase 7 — Email

### Prompt 7.1 — `notifications` crate: outbox, `NotificationAttempt`, and the five triggers

**References:** [ADR-0010](adrs/0010-email-provider-and-delivery.md) in
full, [notifications.md](ddd/notifications.md) in full,
[context-map.md](ddd/context-map.md) ("2b. Reactive, best-effort
concerns" section).

**Task:** Implement the transactional-outbox poller
(`domain_event_outbox` table + a background Tokio task) per
context-map.md's mechanism (b). Implement `NotificationAttempt`,
`TriggerType`, `Channel`, `AttemptStatus`, and
`NotificationAttemptRepository` exactly per notifications.md, including
both idempotency mechanisms (`exists_for_source_event` for the three
outbox-sourced triggers; `exists_for_occurrence` for the time-sourced
meeting-reminder trigger). Implement `EmailProvider` against Postmark's
HTTP API via `reqwest`
([ADR-0010](adrs/0010-email-provider-and-delivery.md) — **not** SMTP/
`lettre`), with Resend (`resend-rs`) as the documented fallback
implementation behind the same trait. Author the five brand-compliant
HTML email templates (concept.md section 7's palette, no em/en dashes)
using a compile-time-checked templating crate (`askama` or `minijinja`)
per ADR-0010, checked into version control.

Wire all five triggers per notifications.md's mapping: signup
confirmation and assignment-approved and hours-approved consume their
respective outbox events; meeting reminder runs its own scheduled Tokio
job against Prompt 3.1's `UpcomingEventOccurrencesQuery`; verification-letter-ready
is written directly to the outbox by Prompt 6.1's HTTP handler
immediately after a successful Typst render (per notifications.md's note
that this one trigger breaks the "event from an aggregate save" pattern —
implement it exactly as that section specifies, not as a repository
event).

Coordinate the `DiscordDmSender` port shape with Prompt 5.2 so both sides
agree without duplication.

**Exit criteria (closes build-roadmap.md's Phase 7 criteria in full):**
All five triggers tested end-to-end against the real provider in a dev/
sandbox environment, not just template rendering in isolation. Brand
compliance verified on every template. A failed `EmailProvider::send` or
`DiscordDmSender::send_dm` call results in a `Failed`-status
`NotificationAttempt` and is retried on the next poller tick, not looped
synchronously in the request path — test this by forcing a provider
failure and asserting the retry behavior, not just the failure record.

**Phase 7 is complete when Prompt 7.1 passes and build-roadmap.md's full
Phase 7 exit-criteria list is satisfied.**

---

## Phase 8 — Admin

### Prompt 8.1 — Roster CSV export and hours report

**References:** concept.md section 8, Prompts 3.1 and 4.1's read ports.

**Task:** Build the admin roster view with filters and CSV export, and the
hours report by project and date range, reusing
`find_approved_by_volunteer_and_range`-shaped queries (Prompt 4.1) rather
than introducing a second reporting query path that could drift from the
verification-letter totals.

**Exit criteria:** CSV export tested against a non-trivial dataset
(pagination/large roster — do not test only against a handful of rows).
Hours report totals verified to match source `HourEntry` data exactly via
a reconciliation test (sum the report's output, sum the raw approved
`HourEntry` rows for the same filter, assert equality).

---

### Prompt 8.2 — Audit-log coverage test suite (blocking gate)

**References:** [ADR-0005](adrs/0005-audit-log-and-co-leads.md),
[compliance-audit.md](ddd/compliance-audit.md) ("Which aggregates across
the system emit audit-worthy events" table).

**Task:** This is a **verification** prompt, not new feature work — its
entire job is to prove Prompt 1.4's framework-level audit wiring actually
covers every mutation path built across Phases 1–8. Using
compliance-audit.md's synthesized table as the checklist, write a
coverage test suite that exercises every listed "Yes" `AuditableEvent`
(volunteer onboarded/approved/oauth-linked/role-changed; project
created/lead-added/lead-removed/closed; assignment
applied/approved/removed; hours logged/approved/rejected/adjusted;
Discord link completed) and asserts each produces exactly the specified
`action`/`entity_type` row in `audit_log`.

**Exit criteria (closes build-roadmap.md's Phase 8 blocking gate exactly
as stated there):** Every admin mutating action across every phase built
so far is verified via this coverage test to produce an AuditLog entry.
**This phase is not done if any admin mutation path is unaudited** — per
build-roadmap.md's own explicit framing, treat any gap this test finds as
a Phase 8 blocker to fix, not a note for later.

**Phase 8 is complete when Prompts 8.1–8.2 both pass and build-roadmap.md's
full Phase 8 exit-criteria list is satisfied.**

---

## Phase 9 — Semantic matching (differentiator, not core)

**Do not start this phase before Phases 1–8 are stable**, per concept.md's
own sequencing note and build-roadmap.md's explicit Phase 9 framing.

### Prompt 9.1 — Isolated `ruvector` matching service

**References:** [ADR-0013](adrs/0013-semantic-matching-vector-layer.md)
in full.

**Task:** This is the **second and last** sanctioned TypeScript exception
in the entire system. Build the `ruvector`-based semantic-matching layer
as its **own bounded service/module**, called by the Rust backend over an
internal API — per ADR-0013, explicitly **not** embedded in-process in the
Axum server (no Node-subprocess/FFI bridge). Grant it **read-only** access
to volunteer skills text and project descriptions only; it must not hold
its own copy of authorization-sensitive state. Every suggestion it returns
must be re-checked against the same RLS/authorization rules
([ADR-0004](adrs/0004-orm-and-row-level-security.md)) as any other query
before being shown to a user — this is the specific safeguard against the
cross-project/cross-volunteer data-leakage risk build-roadmap.md's Phase 9
exit criteria name explicitly.

The deterministic SQL directory search built in Prompt 3.3 must remain
fully functional and unmodified by this prompt — this layer is additive
per concept.md, never a replacement.

**Exit criteria (closes build-roadmap.md's Phase 9 criteria in full):**
Matching quality validated against a labeled test set of realistic skill
descriptions, not just "it returns something." A test proves the
deterministic SQL search still works identically with this layer disabled
or erroring. A test specifically attempts to leak a suggestion result to
a user unauthorized to see the underlying project/volunteer and confirms
it is blocked by the re-checked authorization, not merely by chance.

**Phase 9 is complete when Prompt 9.1 passes and build-roadmap.md's full
Phase 9 exit-criteria list is satisfied.**

---

## Phase 10 — Compliance hardening

**This is a full-surface audit and closeout phase, not new feature work.**
Depends on all prior phases.

### Prompt 10.1 — Full-site WCAG 2.1 AA audit

**References:** concept.md section 9, build-roadmap.md's Phase 10 scope.

**Task:** Run a full-site accessibility audit — automated (axe-core) and
manual (keyboard-only navigation, plus at least one screen reader pass:
NVDA, JAWS, or VoiceOver) — covering every flow built in Phases 2 through
9, not only the per-phase gates already passed individually. Document
results per page/flow. Fix every finding before marking this prompt
complete; this is in addition to, not a substitute for, the Phase 2/3/4
per-phase WCAG gates already required.

**Exit criteria:** Documented, page-by-page/flow-by-flow audit results
with all findings resolved.

---

### Prompt 10.2 — Data-subject requests: export and anonymization

**References:** [compliance-audit.md](ddd/compliance-audit.md)
("Aggregate: `DataSubjectRequest`" and "The Deletion invariant" sections)
in full.

**Task:** Implement `DataSubjectRequest`, `RequestType`, `RequestStatus`,
and their invariants exactly per compliance-audit.md, including the
`Received → InProgress → Completed`/`Rejected` status-transition rule and
the `handled_by`-must-be-Admin requirement (checked via the `AdminUser`
extractor). Implement `Volunteer::anonymize` in `identity-access`
exactly per compliance-audit.md's specification — **anonymization in
place, never physical row deletion** — preserving every FK reference from
`audit_log`, `assignment`, and `hour_entry` intact, per the documented
rationale that those rows are the Foundation's own compliance records,
independent of the requester's erasure wishes. Implement the `Export`
path as a read-only aggregation across `VolunteerRepository`,
`AssignmentRepository`, and `HourEntryRepository`. Wire the privacy
policy page with the stated retention period.

**Exit criteria (closes build-roadmap.md's Phase 10 "deletion request path
functional end-to-end" criterion):** A test suite asserts **both**
directions of the anonymization requirement: the anonymized fields are
genuinely unrecoverable (no soft-delete flag hiding original values
anywhere), and every FK that referenced the volunteer still resolves
without error after anonymization. Privacy policy published with the
stated retention period.

---

### Prompt 10.3 — Breach runbook, GDPR Art. 27 monitoring, and backup restore test

**References:** [ADR-0014](adrs/0014-gdpr-article-27-representative.md),
[ADR-0015](adrs/0015-pipeda-breach-notification-and-privacy-officer.md).

**Task:** This prompt is partly organizational, not purely code — flag the
non-code parts explicitly to the Foundation rather than assuming they can
be satisfied by a commit. Author the breach-response runbook
[ADR-0015](adrs/0015-pipeda-breach-notification-and-privacy-officer.md)
requires (internal reporting contact, RROSH assessment steps, OPC/
affected-individual notification steps, breach-record entry, post-incident
review). Confirm a named Privacy Officer has been designated by the
Foundation (an organizational decision this codebase cannot make for
them — do not close this criterion without an actual named person).
Implement the EU-volunteer-count monitoring query
([ADR-0014](adrs/0014-gdpr-article-27-representative.md)'s 10-volunteer
trigger) against the country/region field added in Prompt 2.3, surfaced
in the admin roster view, and confirm the occasional-processing exemption
rationale is published in the privacy policy (Prompt 10.2). Perform an
actual backup restore test against Neon's backup mechanism and document
the result — per build-roadmap.md, encryption/backups must be
**restore-tested**, not merely configured.

**Exit criteria (closes build-roadmap.md's Phase 10 criteria in full):**
Breach notification runbook documented with a named accountable privacy
officer. GDPR Art. 27 decision executed (exemption rationale published,
monitoring query live and checked against real roster data). A backup has
been restored at least once and verified, with the verification
documented.

**Phase 10, and the full build, is complete when Prompts 10.1–10.3 all
pass and build-roadmap.md's full Phase 10 exit-criteria list is
satisfied.**

---

## A note on drift, for whoever picks this up

Every prompt above cites the specific ADR(s) and DDD file(s) it implements
and states the exit criteria that close out of build-roadmap.md. If, while
implementing any of these, an accepted decision turns out to be wrong,
incomplete, or in conflict with another accepted document — the way the
DDD pass found a real gap in the original ADR-0006 — the correct response
is the same one used throughout this planning process: stop, amend the
relevant ADR or DDD file in place with a dated note explaining what
changed and why (per ADR-0006's own amendment as the worked example), and
only then continue implementation against the corrected document. Do not
silently implement something different from what an ADR says, and do not
silently let two planning documents disagree.
