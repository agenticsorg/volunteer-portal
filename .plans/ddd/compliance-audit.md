# Bounded Context: Compliance & Audit

See [context-map.md](./context-map.md) for the `AuditableEvent` trait, the
audit-capture mechanism (same-transaction write via the `apps/api`
scoped-transaction helper, per
[ADR-0004](../adrs/0004-orm-and-row-level-security.md)/
[ADR-0005](../adrs/0005-audit-log-and-co-leads.md)), and the separate
transactional-outbox mechanism for reactive/best-effort concerns. Crate:
`crates/compliance-audit`. Depends on `kernel` and `identity-access` only
(for `VolunteerId`, `Role`, `VolunteerSummary`), matching every other
context's dependency shape in
[projects-assignments.md](./projects-assignments.md) and
[hours-verification.md](./hours-verification.md).

This context does **not** re-decide the audit-capture mechanism — that is
ADR-0004/ADR-0005's territory, already accepted. Its job is (1) the
read/query side of `AuditLog`, and (2) the `DataSubjectRequest` process
that PIPEDA/GDPR require, which is genuine new domain behavior with its
own invariants. The privacy-officer designation, breach-notification
runbook, and GDPR Art. 27 representative question that
`research-findings.md` flags are organizational/legal-process gaps, not
modeled here — they belong to a forthcoming ADR (referenced in
`build-roadmap.md`'s Phase 0 list) and Phase 10's compliance-hardening
pass, not to this domain model.

## `AuditLog`: read-side only, not this context's write path

**This context does not construct `audit_log` rows.** Every other
context's mutating command handlers return domain events; any event
implementing `AuditableEvent` is written to `audit_log` by the `apps/api`
scoped-transaction helper, in the same Postgres transaction as the
aggregate save, per context-map.md's mechanism (a). No code in
`compliance-audit` sits in that write path — if it did, every mutating
handler in every other context would need to know about and call into
this crate, which is exactly the "every context remembering to call an
audit API by hand" failure mode context-map.md's goal explicitly rejects.

What this context *does* own: the query/read API over `audit_log` (admin
audit-trail views — `concept.md` section 9's audit requirement is
meaningless if nobody can ever look at it) and the conceptual authority
over the table's schema/enum values, since it is the one place all
`AuditAction`/`AuditEntityType` values need to be enumerated consistently
across every other context's `AuditableEvent` implementations.

```rust
pub struct AuditLogEntry {
    pub id: Uuid,
    pub actor_id: Option<VolunteerId>,   // None only for ActorId::System
    pub action: AuditAction,
    pub entity_type: AuditEntityType,
    pub entity_id: Uuid,
    pub before: Option<serde_json::Value>,
    pub after: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

// Mirrors ADR-0005's `action` column exactly, extended only with values
// the other context files actually name (see the table below) — not
// speculatively.
pub enum AuditAction {
    Created,
    Updated,
    Deleted,
    HourApproved,
    HourRejected,
    HourAdjusted,
    RoleChanged,
    Custom(&'static str),   // escape hatch for a new action value without
                              // a breaking enum change; still stored as
                              // its literal text in the `action` column,
                              // matching ADR-0005's "text (enum-checked)"
                              // column type rather than a Postgres native
                              // enum, so new values don't require a
                              // migration
}
```

### `AuditEntityType`: extended once, deliberately, not per-context ad hoc

ADR-0005's `entity_type` column lists `volunteer`, `project`, `assignment`,
`hour_entry` — the four core tables as they stood when that ADR was
accepted. This context adds exactly one more value, and explicitly
declines two others:

```rust
pub enum AuditEntityType {
    Volunteer,
    Project,
    Assignment,
    HourEntry,
    DataSubjectRequest,   // added here — see below
}
```

- **`DataSubjectRequest` is added.** `DataSubjectRequestReceived` and
  `DataSubjectRequestCompleted` (below) are unambiguously audit-worthy —
  a record of who asked for their data to be exported or deleted, and
  when/how it was resolved, is itself compliance evidence, arguably the
  single most important row type in this table for a PIPEDA/GDPR audit.
  It would be a strange gap to model `HourAdjusted` in exhaustive detail
  and leave the erasure-request trail unrecorded.
- **A Discord-link entity type is *not* added.** `identity-access.md`'s
  `OAuthAccountLinked` event already has `entity_type: Volunteer` (linking
  a provider is a fact about the `Volunteer` aggregate, not a distinct
  entity) — there is nothing for a `discord_link` entity type to refer to
  that isn't already covered.
- **A notification-attempt entity type is *not* added.** Whether an email
  send succeeded or failed is delivery telemetry, not a domain-state
  change with a "before/after" shape — it doesn't answer "what changed
  and who changed it," which is what `audit_log` is for. Delivery
  history belongs in Notifications' own `NotificationAttempt` record (see
  [notifications.md](./notifications.md) once written), queryable
  separately for operational debugging, not commingled with the
  compliance audit trail. If a future requirement needs "prove a
  verification-letter-ready email was sent" as compliance evidence rather
  than ops telemetry, that is a deliberate future extension of this enum,
  not an oversight now.

```rust
pub trait AuditLogQuery: Send + Sync {
    async fn find_by_entity(
        &self, tx: &mut Transaction<'_, Postgres>,
        entity_type: AuditEntityType, entity_id: Uuid,
    ) -> Result<Vec<AuditLogEntry>, RepoError>;

    async fn find_by_actor(
        &self, tx: &mut Transaction<'_, Postgres>,
        actor_id: VolunteerId, range: DateRange,
    ) -> Result<Vec<AuditLogEntry>, RepoError>;

    async fn find_by_action(
        &self, tx: &mut Transaction<'_, Postgres>,
        action: AuditAction, range: DateRange,
    ) -> Result<Vec<AuditLogEntry>, RepoError>;  // e.g. "show me every
                                                    // hour_adjusted row this
                                                    // quarter" for admin review
}
```

As with every port in this model, the transaction is caller-supplied
(ADR-0004's `SET LOCAL app.current_user_id` wrapper) — admin-scoped
queries here are themselves subject to RLS, since an audit trail that
leads is allowed to browse other leads' projects' history through would
be its own compliance problem.

## Aggregate: `DataSubjectRequest`

Models a PIPEDA/GDPR export or deletion request as a first-class process
with a lifecycle — not an ad hoc admin script run once and forgotten,
which would leave no evidence the request was ever handled correctly.

```rust
pub struct DataSubjectRequest {
    id: DataSubjectRequestId,
    volunteer_id: VolunteerId,
    request_type: RequestType,       // Export | Deletion
    status: RequestStatus,           // Received | InProgress | Completed | Rejected
    requested_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
    handled_by: Option<VolunteerId>, // admin who actioned it; None while Received
    rejection_reason: Option<String>,
}

pub enum RequestType { Export, Deletion }
pub enum RequestStatus { Received, InProgress, Completed, Rejected }
```

### Invariants

1. **`status` transitions are `Received → InProgress → Completed`, or
   `Received/InProgress → Rejected`.** `Rejected` requires a non-empty
   `rejection_reason` — a deletion or export request cannot simply
   vanish without a recorded justification, since the request itself is
   already audit-logged as `Received` (see events below) and an
   unexplained disappearance would look identical to negligence in a
   later audit.
2. **`Rejected` is narrow, not a general-purpose stall.** The only
   legitimate rejection ground this model anticipates is a **live legal
   hold or an unresolved dispute directly involving the volunteer's own
   records** (e.g. an open investigation into a reported code-of-conduct
   violation where their records are evidence) — not routine
   administrative inconvenience. This is stated as guidance for the
   handling admin, not encoded as a closed enum of reasons, since the
   legitimate grounds are a legal question this document is not
   positioned to enumerate exhaustively.
3. **`handled_by` is required before `Completed` or `Rejected`**, and
   must resolve to a volunteer with `Role::Admin` (`identity-access.md`'s
   `Role`) — checked via the `apps/api` `AdminUser` extractor before the
   command handler runs, matching the pattern `LeadOf`/`AuthUser`
   establish elsewhere (ADR-0002).

### The Deletion invariant: anonymization, not physical deletion

**This is a recommendation this document is making, not a decision
already locked by an ADR** — no ADR for data-subject deletion exists yet
in `.plans/adrs/` (0001–0005 only as of this writing).

A literal `DELETE FROM volunteer WHERE id = ...` is not a coherent
operation in this schema: `audit_log.actor_id`, `audit_log.entity_id`
(when `entity_type = Volunteer`), `assignment.volunteer_id`, and
`hour_entry.volunteer_id` all reference it, and several of those
references are themselves compliance records that must *not* disappear
(an approved `HourEntry` that fed a verification letter, or an
`audit_log` row recording that this same volunteer's own hours were
adjusted, are evidence the Foundation needs to retain for its own
recordkeeping and dispute-resolution purposes independent of the
requester's wishes). Cascading the delete would either orphan those rows
(FK violation, or `ON DELETE SET NULL` silently corrupting the audit
trail's `actor_id`) or cascade further into deleting `hour_entry`/
`assignment` history that other volunteers' project rosters and the
Foundation's own hours reporting still depend on.

**Recommendation: `DataSubjectRequest::complete_deletion` anonymizes the
`Volunteer` aggregate in place rather than removing the row.** The
`VolunteerId` and row survive; personally identifying fields are
overwritten with tombstone values:

```rust
impl Volunteer {
    /// Called only by compliance-audit's DataSubjectRequest completion
    /// flow, never as a general-purpose edit — this is why it returns a
    /// distinct event (VolunteerAnonymized) rather than reusing whatever
    /// generic "profile updated" event identity-access.md might have.
    pub fn anonymize(self) -> Volunteer {
        Volunteer {
            name: "[deleted volunteer]".into(),
            email: format!("deleted-{}@invalid", self.id),
            discord_id: None,
            timezone: "UTC".into(),
            skills: vec![],
            availability: Availability::default(),
            oauth_links: vec![],
            status: VolunteerStatus::Suspended,
            ..self   // id, agreements timestamps, role, created_at retained —
                     // the *fact* they once agreed to the code of conduct at
                     // a given time is itself a record worth keeping, distinct
                     // from their identity
        }
    }
}
```

This satisfies "actual data removal or documented anonymization, verified
by test" (`build-roadmap.md` Phase 10 exit criteria) under its
"documented anonymization" branch: identifying data is irrecoverably
overwritten (not merely flagged hidden), while `audit_log`, `hour_entry`,
and `assignment` referential integrity — and the Foundation's own
compliance need to retain records of what happened — stay intact. A test
suite for this should assert both directions: the anonymized fields are
genuinely unrecoverable (no soft-delete flag hiding the original values
somewhere), and every FK that referenced the volunteer still resolves.

**Export** (`RequestType::Export`) has no equivalent tension — it is a
read-only aggregation across `identity-access`'s `VolunteerRepository`,
`projects-assignments`'s `AssignmentRepository`, and
`hours-verification`'s `HourEntryRepository`, similar in shape to
`VerificationLetterService`'s read-only rollup in
[hours-verification.md](./hours-verification.md), producing a data
package rather than mutating anything.

## Domain events

- `DataSubjectRequestReceived { request_id, volunteer_id, request_type }`
  — `AuditableEvent` (action: `Created`, entity_type:
  `DataSubjectRequest`).
- `DataSubjectRequestCompleted { request_id, method: CompletionMethod }`
  — `AuditableEvent` (action: `Updated`, entity_type:
  `DataSubjectRequest`), where `CompletionMethod` is `Anonymized |
  Exported`.
- `VolunteerAnonymized { volunteer_id, request_id }` — `AuditableEvent`
  (action: `Updated`, entity_type: `Volunteer`) — emitted **in addition
  to** `DataSubjectRequestCompleted`, distinct from any of
  [identity-access.md](./identity-access.md)'s normal `Volunteer`
  mutation events (`VolunteerApproved`, `RoleChanged`, etc.), because this
  is a compliance-mandated erasure action, not a routine profile edit or
  admin decision — an auditor scanning `audit_log` for "was this
  volunteer's data ever erased" should be able to filter on this specific
  action/entity pair without wading through ordinary profile-update
  noise. This event is emitted by `identity-access`'s `VolunteerRepository::save`
  when persisting the result of `Volunteer::anonymize`, since
  `compliance-audit` does not hold `Volunteer` aggregate internals
  directly (per the acyclic dependency rule in context-map.md) — this
  context's `DataSubjectRequest` application service calls
  `identity-access`'s repository/command surface to perform the
  anonymization, then records its own `DataSubjectRequestCompleted`
  alongside it.

## Repository port

```rust
#[async_trait]
pub trait DataSubjectRequestRepository: Send + Sync {
    async fn find_by_id(
        &self, tx: &mut Transaction<'_, Postgres>, id: DataSubjectRequestId,
    ) -> Result<Option<DataSubjectRequest>, RepoError>;

    async fn find_by_volunteer(
        &self, tx: &mut Transaction<'_, Postgres>, volunteer_id: VolunteerId,
    ) -> Result<Vec<DataSubjectRequest>, RepoError>;

    async fn find_pending(
        &self, tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<DataSubjectRequest>, RepoError>;  // admin queue, mirrors
                                                          // HourEntryRepository::
                                                          // find_pending_for_lead's
                                                          // shape in hours-verification.md

    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, request: &DataSubjectRequest,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}
```

## Which aggregates across the system emit audit-worthy events

Synthesized from context-map.md's ownership table and every context file
written so far (`projects-assignments.md`, `hours-verification.md`,
`identity-access.md` are complete; `discord-integration.md` and
`notifications.md` were still being drafted by sibling agents at the time
this table was compiled — their expected events are included below based
on context-map.md's stated ownership and the event names their own
drafting briefs named, and should be reconciled against those files' final
text once written).

**Amended — 2026-08-20** (Phase 5 architecture-consistency review): this
is that reconciliation for `discord-integration.md`'s `DiscordLinkCompleted`
row, which the table below no longer lists. Prompt 5.2 implementation
surfaced that `discord-integration.md`'s original `/link`-handling sketch
couldn't be built as written — it assumed a direct
`Volunteer`/`OAuthLink`-mutating port that `identity-access.md`/ADR-0007's
actual account-linking design doesn't provide (linking requires an
authenticated web session plus a real OAuth handshake with the second
provider, neither of which a bare Discord interaction supplies).
`discord-integration.md` was corrected in place: `LinkCommandHandler` is
now read-only (an idempotency check plus a reply directing the volunteer
to the existing web linking flow), emits no event, and mutates nothing —
every actual linking mutation, regardless of which flow nudged the
volunteer toward it, converges on `identity-access.md`'s existing
`OAuthAccountLinked` event, listed below. See
[discord-integration.md](./discord-integration.md)'s matching amendment
for the full reasoning.

| Context | Aggregate/Service | Event | `AuditableEvent`? | `action` value |
|---|---|---|---|---|
| Identity & Access | `Volunteer` | `VolunteerOnboarded` | Yes | `Created` |
| Identity & Access | `Volunteer` | `VolunteerApproved` | Yes | `Updated` |
| Identity & Access | `Volunteer` | `OAuthAccountLinked` | Yes | `Updated` |
| Identity & Access | `Volunteer` | `RoleChanged` | Yes | `RoleChanged` |
| Projects & Assignments | `Project` | `ProjectCreated` | Yes | `Created` |
| Projects & Assignments | `Project` | `ProjectLeadAdded` | Yes | `Updated` |
| Projects & Assignments | `Project` | `ProjectLeadRemoved` | Yes | `Updated` |
| Projects & Assignments | `Project` | `ProjectClosed` | Yes | `Updated` |
| Projects & Assignments | `Assignment` | `AssignmentApplied` | Yes | `Created` |
| Projects & Assignments | `Assignment` | `AssignmentApproved` | Yes | `Updated` |
| Projects & Assignments | `Assignment` | `AssignmentRemoved` | Yes | `Deleted` |
| Hours & Verification | `HourEntry` | `HoursLogged` | Yes | `Created` |
| Hours & Verification | `HourEntry` | `HoursApproved` | Yes | `HourApproved` |
| Hours & Verification | `HourEntry` | `HoursRejected` | Yes | `HourRejected` |
| Hours & Verification | `HourEntry` | `HoursAdjusted` | Yes | `HourAdjusted` |
| Discord Integration | `RoleReconciler` | `DiscordRoleReconciled` (routine tick) | **No** — logged to this context's own `reconcile_run_log` instead; a system-actor operational event has no natural `entity_type` slot and would dilute the compliance-focused log, per [discord-integration.md](./discord-integration.md) | n/a |
| Notifications | — | `NotificationSent` / `NotificationFailed` | **No** — delivery telemetry, not a domain-state change; visible instead via Notifications' own `NotificationAttemptRepository`, per [notifications.md](./notifications.md) | n/a |
| Compliance & Audit | `DataSubjectRequest` | `DataSubjectRequestReceived` | Yes | `Created` |
| Compliance & Audit | `DataSubjectRequest` | `DataSubjectRequestCompleted` | Yes | `Updated` |
| Compliance & Audit | `Volunteer` (via Identity & Access) | `VolunteerAnonymized` | Yes | `Updated` |

The mechanism that makes this table enforceable rather than aspirational
is entirely in context-map.md and ADR-0005: a context only has to
implement `AuditableEvent` correctly on the events listed "Yes" above;
it never writes to `audit_log` itself, and there is no separate
per-context checklist to remember to run — the `apps/api`
scoped-transaction helper captures every `AuditableEvent` a command
handler returns, unconditionally. This table's job is to be the
reference a reviewer checks a new domain event against ("should this
implement `AuditableEvent`, and if so with which `action`/`entity_type`")
— it is documentation of intent, not itself a runtime gate.
