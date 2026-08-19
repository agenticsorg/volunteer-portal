# Bounded Context: Hours & Verification

See [context-map.md](./context-map.md) for the event-hours decision and
[projects-assignments.md](./projects-assignments.md) for the
`Assignment.participation_mode` invariant this context depends on and
enforces the other half of. Crate: `crates/hours-verification`. Depends on
`kernel` and `identity-access`; consumes `projects-assignments`'s
`LeadMembershipQuery` and `AssignmentSnapshot` read port (defined below) —
no dependency on `projects-assignments`'s aggregate internals.

## Aggregate: `HourEntry`

```rust
pub struct HourEntry {
    id: HourEntryId,
    volunteer_id: VolunteerId,
    assignment_id: AssignmentId,
    date: NaiveDate,
    hours: Hours,                      // value object, see below
    description: String,               // short free text, required
    status: HourEntryStatus,           // Pending | Approved | Rejected
    approver_id: Option<VolunteerId>,
    decided_at: Option<DateTime<Utc>>,
    adjustment: Option<Adjustment>,    // present only if an admin adjusted post-approval
}

pub enum HourEntryStatus { Pending, Approved, Rejected }

/// concept.md section 8: "manual hour adjustment with a visible audit trail"
pub struct Adjustment {
    adjusted_by: VolunteerId,          // admin, global scope
    previous_hours: Hours,
    reason: String,                    // required, not optional — a bare number
                                        // change with no reason is not an
                                        // acceptable audit trail entry
    adjusted_at: DateTime<Utc>,
}
```

### Value object: `Hours`

```rust
pub struct Hours(Decimal);  // rust_decimal, not f64 — hours feed verification
                             // letters and legal/compliance-facing totals

impl Hours {
    pub fn new(value: Decimal) -> Result<Self, HourEntryError> {
        if value <= Decimal::ZERO {
            return Err(HourEntryError::NonPositiveHours);
        }
        if value > Decimal::from(24) {
            return Err(HourEntryError::ExceedsSingleEntryMax); // catches obvious
                                                                 // fat-finger entry;
                                                                 // does not block
                                                                 // legitimate multi-day
                                                                 // rollups, which are
                                                                 // always per-date rows
        }
        Ok(Hours(value))
    }
}
```

### The event-hours invariant, enforced at construction (the other half)

```rust
/// A minimal, read-only view of the Assignment this HourEntry is logged
/// against — obtained via the AssignmentSnapshotQuery port, not by this
/// context reaching into projects-assignments's aggregate.
pub struct AssignmentSnapshot {
    pub assignment_id: AssignmentId,
    pub volunteer_id: VolunteerId,
    pub project_id: ProjectId,
    pub participation_mode: ParticipationMode,   // Contributor | Attendee
    pub status: AssignmentStatus,
}

impl HourEntry {
    /// The only constructor for a self-logged entry.
    pub fn log(
        assignment: &AssignmentSnapshot,
        date: NaiveDate,
        hours: Hours,
        description: String,
    ) -> Result<HourEntry, HourEntryError> {
        if assignment.participation_mode != ParticipationMode::Contributor {
            return Err(HourEntryError::AssignmentNotEligibleForHours);
        }
        if assignment.status != AssignmentStatus::Approved {
            return Err(HourEntryError::AssignmentNotActive);
        }
        if description.trim().is_empty() {
            return Err(HourEntryError::DescriptionRequired);
        }
        Ok(HourEntry {
            id: HourEntryId::new(),
            volunteer_id: assignment.volunteer_id,
            assignment_id: assignment.assignment_id,
            date,
            hours,
            description,
            status: HourEntryStatus::Pending,
            approver_id: None,
            decided_at: None,
            adjustment: None,
        })
    }
}
```

This is the concrete, binding answer to `research-findings.md`'s question
("does event participation accrue hours, or must the application prevent
`HourEntry.assignment_id` from targeting event-type assignments?"): **it
is prevented, structurally, at the domain layer**, by refusing
construction rather than by a UI-level hidden button or a feature flag.
`HourEntryError::AssignmentNotEligibleForHours` is a typed error the API
layer maps to a 4xx response with a clear message — a volunteer with an
`Attendee`-mode event assignment never even reaches a state where an hours
form is a meaningful action, but the invariant does not depend on the
frontend getting that right.

**Defense in depth:** a Postgres `CHECK`/trigger constraint mirroring this
rule (reject `INSERT INTO hour_entry` where the referenced assignment's
computed `participation_mode` is not `Contributor`) is recommended at
Phase 1 schema design, matching the same defense-in-depth posture ADR-0004
already applies to RLS (app-layer check backed by a database-layer
guarantee). This DDD document specifies the invariant; the exact
constraint SQL is implementation detail for Phase 1.

### Other invariants

- Only `Pending` entries can transition to `Approved`/`Rejected`.
- The approver must be a lead of the entry's project (`LeadMembershipQuery`
  against `assignment.project_id`) or an admin (global scope) — checked by
  the `apps/api` `LeadOf`/`AdminUser` extractors first, re-checked in the
  domain layer for bulk-approve (`concept.md` section 5's "bulk approve"),
  since a single-entry extractor doesn't cover a batch spanning multiple
  projects.
- `Adjustment` can only be applied to an `Approved` entry, only by an
  admin (not a lead — this matches `concept.md` section 8 placing manual
  adjustment under Admin, not project leads), and always requires a
  non-empty `reason`.

### Domain events

- `HoursLogged { hour_entry_id, assignment_id, volunteer_id, hours, date }`
  — `AuditableEvent` (action: `Created`, entity_type: `HourEntry`).
- `HoursApproved { hour_entry_id, approver_id }` — `AuditableEvent`
  (action: `Updated`); also outboxed for Notifications ("hours approved"
  trigger) and Discord Integration (role sync may depend on cumulative
  approved-hour milestones in a future version — not v1, but the event
  exists regardless so this isn't a later schema change).
- `HoursRejected { hour_entry_id, approver_id, reason: Option<String> }` —
  `AuditableEvent` (action: `Updated`).
- `HoursAdjusted { hour_entry_id, adjusted_by, previous_hours, new_hours, reason }`
  — `AuditableEvent` (action: `Custom("hour_adjusted")`, matching
  ADR-0005's `audit_log.action` enum value `hour_adjusted` exactly) — this
  is the event `concept.md` section 8's "visible audit trail" requirement
  is actually about; it carries `before`/`after` explicitly rather than
  relying on a generic diff, since `Hours` is the one field that matters
  here and a generic snapshot diff would bury it in noise.

### Repository port

```rust
#[async_trait]
pub trait HourEntryRepository: Send + Sync {
    async fn find_by_id(
        &self, tx: &mut Transaction<'_, Postgres>, id: HourEntryId,
    ) -> Result<Option<HourEntry>, RepoError>;

    async fn find_pending_for_lead(
        &self, tx: &mut Transaction<'_, Postgres>, lead_id: VolunteerId,
    ) -> Result<Vec<HourEntry>, RepoError>;         // approval queue

    async fn find_approved_by_volunteer_and_range(
        &self, tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId, range: DateRange,
    ) -> Result<Vec<HourEntry>, RepoError>;         // feeds VerificationLetterService
                                                      // and the admin hours report

    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, entry: &HourEntry,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}
```

### `AssignmentSnapshotQuery` port (consumed from `projects-assignments`)

```rust
#[async_trait]
pub trait AssignmentSnapshotQuery: Send + Sync {
    async fn snapshot(
        &self, tx: &mut Transaction<'_, Postgres>, id: AssignmentId,
    ) -> Result<Option<AssignmentSnapshot>, RepoError>;
}
```

Implemented by `projects-assignments`, injected here — this is the
[context-map.md](./context-map.md) direct-call mechanism, chosen because
`HourEntry::log`'s invariant must see live, correct `participation_mode`,
never a stale event-derived copy.

## Verification letters: a process, not a stored entity

`concept.md` section 5 is explicit: letters are "rendered on demand,"
never stored as a document. This context therefore has **no
`VerificationLetter` aggregate, no `verification_letter` table**. It is
modeled as a domain service operating on a read model:

```rust
pub struct VerificationLetterDraft {
    pub volunteer_id: VolunteerId,
    pub volunteer_name: String,
    pub range: DateRange,
    pub total_hours: Hours,
    pub project_breakdown: Vec<(ProjectName, Hours)>,
    pub generated_at: DateTime<Utc>,
}

pub struct VerificationLetterService<R: HourEntryRepository> {
    hour_entries: R,
}

impl<R: HourEntryRepository> VerificationLetterService<R> {
    pub async fn draft(
        &self, tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId, range: DateRange,
    ) -> Result<VerificationLetterDraft, HourEntryError> {
        let entries = self.hour_entries
            .find_approved_by_volunteer_and_range(tx, volunteer_id, range)
            .await?;
        // sum + group by project; entries here are, by construction,
        // always Contributor-mode (see HourEntry::log), so no event-hours
        // filtering is needed at this layer — the exclusion already
        // happened at the source.
        Ok(build_draft(volunteer_id, range, entries))
    }
}
```

`VerificationLetterDraft` is handed to a separate infrastructure-layer
Typst renderer (outside this crate's domain module, in its `infra`
submodule) that turns it into PDF bytes for the HTTP response — the draft
itself is never persisted, satisfying "rendered on demand" structurally:
there is no table to accidentally start writing to later. Because
`HourEntry` can only ever exist for `Contributor`-mode assignments, the
letter's hour total is automatically correct with respect to the
event-hours decision without the service needing its own opinion on
events at all — this is the payoff of enforcing the invariant at
`HourEntry` construction rather than filtering at read time in every
consumer.

## `Hours & Verification`'s stance if the event-hours decision changes later

If the Foundation later decides meetup attendance *should* count (e.g. for
volunteers logging significant setup/teardown time even as attendees),
the change is localized: relax `Assignment::apply`'s `participation_mode`
computation in `projects-assignments.md` to allow `Contributor` for
ordinary attendees under some new rule, and nothing in this file's
`HourEntry::log` invariant needs to change at all — it already defers
entirely to `participation_mode`. This is the reason the invariant lives
on `Assignment` construction rather than being duplicated as a
`Project.project_type == Event` check inside `HourEntry` itself: one
source of truth, one place to revisit.
