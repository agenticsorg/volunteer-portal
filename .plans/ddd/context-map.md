# Context Map — Agentics Foundation Volunteer Portal

## Status

Draft — 2026-08-19. Companion to the ADR series in `.plans/adrs/`. This
document and its siblings in `.plans/ddd/` do not re-decide anything already
accepted in an ADR (Rust-first, Axum, SQLx, Neon, `SET LOCAL`
`app.current_user_id`, the `audit_log` and `project_lead` tables from
[ADR-0005](../adrs/0005-audit-log-and-co-leads.md)) — they give that
accepted infrastructure a domain model to sit on top of, and resolve the
product-level ambiguities (event-hours semantics) that the ADRs left to this
pass.

## Bounded contexts

| Context | Owns | Does not own |
|---|---|---|
| **Identity & Access** | Volunteer identity, Discord/Google OAuth linkage, roles (`volunteer`/`lead`/`admin`), sessions, onboarding agreements | Discord role *assignment* (that's Discord Integration reacting to this context's events) |
| **Projects & Assignments** | Project (incl. event-type projects), ProjectLead, Assignment, apply/approve/roster workflow | Hour logging, verification letters |
| **Hours & Verification** | HourEntry, approval queue, manual adjustments, verification-letter generation (a process, not a stored entity) | Assignment eligibility rules it doesn't control — it *consumes* Assignment's `participation_mode` (see below) |
| **Discord Integration** | Anti-corruption layer around the Discord REST API: role reconcile job, `/link` interaction handler, DM/channel notification delivery | Any domain decision about *what* role a volunteer should have — that's computed from Identity & Access / Projects & Assignments state, Discord Integration only executes it |
| **Notifications** | The 5 transactional email triggers, template rendering, delivery-failure handling | Email provider account/branding decisions (ADR-owned) |
| **Compliance & Audit** | AuditLog capture, PIPEDA/GDPR data-subject requests (export, deletion/anonymization) | Individual context invariants — it is a *subscriber*, not a source of truth for other contexts' data |

```
                    ┌─────────────────────┐
                    │  Identity & Access   │   (foundational — every other
                    │  (Volunteer, Role)   │    context depends on it)
                    └──────────┬───────────┘
                               │ VolunteerId, Role (shared vocabulary)
           ┌───────────────────┼────────────────────┬─────────────────┐
           ▼                   ▼                     ▼                 ▼
┌─────────────────────┐ ┌─────────────┐   ┌─────────────────┐  ┌──────────────┐
│ Projects &           │ │ Discord      │   │ Notifications    │  │ Compliance & │
│ Assignments          │ │ Integration  │   │                  │  │ Audit        │
│ (Project, Assignment)│ │ (ACL)        │   │                  │  │ (AuditLog)   │
└──────────┬────────────┘ └─────┬────────┘   └────────┬─────────┘  └──────┬───────┘
           │ ProjectId,          │                     ▲                  ▲
           │ participation_mode  │                     │                  │
           ▼                     │            domain events (outbox)      │
┌─────────────────────┐          │            ─────────────────────────────
│ Hours & Verification │──────────┘            every mutating command's
│ (HourEntry, letters) │                        AuditableEvent, published
└──────────────────────┘                        to both subscribers
```

Arrows down/right are compile-time crate dependencies (direct trait calls).
The dashed fan-in at the bottom is the **event bus**, not a crate
dependency — Notifications and Compliance & Audit never appear in any other
context's `Cargo.toml`.

## Cargo workspace structure

**Decision: crate-per-bounded-context inside one Cargo workspace, one
deployable binary.** Not a distributed system, not one flat crate.

```
volunteer-portal/
  Cargo.toml                      # [workspace] members
  crates/
    kernel/                       # Id<T> newtypes, DomainEvent + AuditableEvent
                                   # traits, ActorId, UnitOfWork, error types,
                                   # RLS transaction guard (SET LOCAL wrapper)
    identity-access/               # Volunteer, Role, Session, OAuthLink
    projects-assignments/          # Project, ProjectLead, Assignment
    hours-verification/            # HourEntry, VerificationLetterService
    discord-integration/           # ACL: RoleReconciler, LinkCommandHandler
    notifications/                 # EmailDispatcher, 5 template renderers
    compliance-audit/              # AuditLog, DataSubjectRequestService
  apps/
    api/                           # Axum composition root: routers, extractors
                                   # (AuthUser, LeadOf per ADR-0002), DI wiring,
                                   # event-bus registration, migrations runner
  migrations/                      # SQLx .sql files, single Postgres schema
```

**Why this and not one flat crate:** `cargo check`/`cargo test` scoped to a
single crate is materially faster once the schema grows past the four core
tables (six, per ADR-0005, before Phase 1 even ships), and Rust's crate
boundary is a real compiler-enforced module boundary — `hours-verification`
physically cannot reach into `projects-assignments`'s private aggregate
fields, only its public ports. That is a stronger guarantee than a
`pub(crate)` convention inside one crate, at near-zero extra ceremony for a
project this size.

**Why not crate-per-context with independent deploys (microservices):**
rejected outright — this is a small nonprofit app, not a distributed
system. `concept.md` section 10 explicitly cautions against
over-engineering. One Axum binary, one Postgres database, one deploy
target. The crate boundary buys modularity and compile-time enforcement
without paying for network calls, service discovery, or distributed
transactions between contexts that must actually be consistent (e.g. an
Assignment's `participation_mode` must be computed from a **live** read of
the owning Project, not an eventually-consistent replica).

**Dependency direction (acyclic, enforced by Cargo):**

```
kernel  ←  identity-access  ←  { projects-assignments, hours-verification,
                                 discord-integration, notifications,
                                 compliance-audit }  ←  apps/api
```

`identity-access` is the one context every other context is allowed to
depend on directly, for its public read types only (`VolunteerId`, `Role`,
`VolunteerSummary`) — "who is this actor" is foundational vocabulary, not a
cross-context integration to be mediated through events. `identity-access`
itself depends on nothing but `kernel`. No other context-to-context edge is
a compile-time dependency; everything else goes through `apps/api`'s
composition root (constructor-injected ports) or the event bus.

## Cross-context communication: two mechanisms, chosen by consistency need

Given the "commercial-grade but not over-engineered" mandate, this model
deliberately uses **two** mechanisms, not one generic pub-sub for
everything — because the two things being coordinated have genuinely
different consistency requirements, and collapsing them into one
mechanism would either make the audit log eventually-consistent (bad: it's
a compliance record) or make email sending block the request transaction
(bad: it's a slow, unreliable external call).

### 1. Direct calls, for anything requiring strong consistency

A command handler in one context that needs a **synchronous, correct-now**
answer from another context depends on that context's **port** (a trait,
not a concrete type), implemented by the owning context, injected at
`apps/api`'s composition root. Example: `hours-verification`'s "approve
hours" handler needs "is this actor a lead for this HourEntry's project" —
it depends on a `LeadMembershipQuery` port that `projects-assignments`
implements against the live `project_lead` table. No event, no cache, no
staleness window — this is the same query the Axum `LeadOf` extractor
(ADR-0002) already performs, exposed as a port so the domain layer can also
call it directly where the extractor alone isn't enough (e.g. bulk-approve
touching multiple projects at once).

### 2. Domain events via a transactional outbox, for reactive/best-effort concerns

Every mutating command handler that changes state in a way meaningful
beyond its own context — role changes, assignment approval, hours
approval, hours adjustment — produces a domain event. Two sub-cases, kept
deliberately distinct:

**a. Audit capture (must never be lost, must be atomic with the state
change).** The command handler's resulting domain event, if it implements
the `AuditableEvent` marker trait (see below), is written to `audit_log`
**in the same Postgres transaction** as the aggregate save — this is what
[ADR-0005](../adrs/0005-audit-log-and-co-leads.md) calls "wired at the
framework level": the `apps/api` scoped-transaction helper (the `SET
LOCAL` wrapper from ADR-0004) is the one place this happens, driven by the
`AuditableEvent` the handler returns. No context-specific code writes to
`audit_log` directly; a context only has to implement `AuditableEvent` on
the right domain events, once, and the framework does the rest. This
directly satisfies the goal of not every context "remembering to call an
audit API by hand."

**b. Reactive, best-effort concerns (notifications, Discord role
reconcile trigger).** The same domain event, if relevant to Notifications
or Discord Integration, is additionally written to a `domain_event_outbox`
table in the same transaction (transactional outbox pattern — no external
broker, it's one more Postgres table, consistent with "no over-engineering
for a small nonprofit app"). A background Tokio task polls the outbox on
an interval, dispatches to registered handlers (send email, or simply mark
"role reconcile needed" — Discord role sync itself stays a scheduled
reconcile job per `concept.md` section 6, it does not react to individual
events in real time), and marks rows delivered. This gives at-least-once
delivery without requiring the request/response cycle to wait on a
third-party email API call.

```rust
// kernel crate
pub trait DomainEvent: Send + Sync + 'static {
    fn event_type(&self) -> &'static str;
    fn occurred_at(&self) -> DateTime<Utc>;
}

pub trait AuditableEvent: DomainEvent {
    fn actor(&self) -> ActorId;                  // Volunteer(VolunteerId) | System
    fn action(&self) -> AuditAction;              // Created | Updated | Deleted | Custom(&'static str)
    fn entity_type(&self) -> AuditEntityType;      // Volunteer | Project | Assignment | HourEntry
    fn entity_id(&self) -> Uuid;
    fn before(&self) -> Option<serde_json::Value>;
    fn after(&self) -> Option<serde_json::Value>;
}

pub enum ActorId {
    Volunteer(VolunteerId),
    System,   // scheduled jobs, e.g. Discord reconcile — audit_log.actor_id nullable for this case
}
```

Every bounded-context file below states which of its domain events
implement `AuditableEvent`.

## The event-hours decision (binding on Projects & Assignments and Hours & Verification)

`research-findings.md` flagged this as a blocking, unresolved product
question: **does attending an event-type Project accrue
verification-letter-eligible hours?**

**Decision: no, with one narrow exception for the event's own lead/host.**

- Ordinary attendees of an event-type Project (the weekly meetup, the
  marketing meeting) get **signup and attendance tracking only** — no
  `HourEntry` can ever be constructed against their Assignment. This
  matches `concept.md` section 4's own framing: events need "signup and
  attendance tracking," never described as hour-loggable, and it avoids
  needing an approval model for passive meetup attendance that nothing in
  the spec asks for.
- The volunteer(s) who **lead/host** an event-type Project — the same
  people `concept.md` section 1 says to seed as the initial `lead`
  accounts from current meeting hosts — **do** accrue hours, because
  hosting a recurring meetup (prep, running it, follow-up) is real
  volunteer effort indistinguishable in kind from project work, and the
  spec already treats meeting hosts as leads, not as ordinary attendees.

This is enforced as a **construction-time invariant on `Assignment`**, not
an app-layer `if` that something could forget: `Assignment` carries a
`participation_mode: ParticipationMode` (`Contributor | Attendee`) that is
computed once, at creation, from `(Project.project_type, is this volunteer
one of the Project's leads)`, and is immutable thereafter. `HourEntry`'s
constructor refuses to build against any Assignment whose
`participation_mode` is not `Contributor`. Full detail, including the
exact factory signatures, is in
[projects-assignments.md](./projects-assignments.md) and
[hours-verification.md](./hours-verification.md) — this is the shared
contract between those two files and must not be reinterpreted
independently by either.

Consequence for other contexts: **Notifications**' "hours approved"
trigger and **Discord**'s role sync only ever see `Contributor`-mode
activity, so no special-casing is needed downstream — the exclusion
happens once, at the source, in the domain layer.

## RLS and the audit trail, mapped to contexts

Every table owned by Projects & Assignments, Hours & Verification, and
Identity & Access is RLS-protected per
[ADR-0004](../adrs/0004-orm-and-row-level-security.md)
(`SET LOCAL app.current_user_id`, `FORCE ROW LEVEL SECURITY`, non-owner
app role). The DDD layer's obligation is narrower than re-deciding that
mechanism: each aggregate's repository trait accepts the already-scoped
transaction (`&mut Transaction<'_, Postgres>`) rather than acquiring its
own connection, so no repository implementation can accidentally bypass
the `SET LOCAL` wrapper by opening an unscoped connection. This is stated
explicitly in each context file's repository trait shapes.

## Files in this set

- `context-map.md` — this file
- `identity-access.md`
- `projects-assignments.md`
- `hours-verification.md`
- `discord-integration.md`
- `notifications.md`
- `compliance-audit.md`
