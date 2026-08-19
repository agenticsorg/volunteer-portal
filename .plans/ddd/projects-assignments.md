# Bounded Context: Projects & Assignments

See [context-map.md](./context-map.md) for the event-hours decision this
context enforces jointly with [hours-verification.md](./hours-verification.md).
Crate: `crates/projects-assignments`. Depends on `kernel` and
`identity-access` only.

## Aggregate: `Project`

Covers both "project" and "event" from `concept.md` section 1, via a
discriminator rather than a separate aggregate — see
[Design note: why Project, not Project+Event](#design-note-why-project-not-projectevent)
below for the reporting-requirement justification.

```rust
pub struct Project {
    id: ProjectId,
    name: String,                    // non-empty, <= 200 chars
    description: String,
    project_type: ProjectType,       // immutable after creation
    needed_skills: Vec<Skill>,
    status: ProjectStatus,           // Open | Closed
    leads: Vec<ProjectLead>,         // co-leads, see ADR-0005's `project_lead` table
    schedule: Option<EventSchedule>, // Some only when project_type == Event
    created_at: DateTime<Utc>,
}

pub enum ProjectType { Project, Event }
pub enum ProjectStatus { Open, Closed }

/// Not in concept.md's original four-object model, added here because
/// `concept.md` section 7 lists "meeting reminder" as a transactional
/// email trigger, which requires *something* to compute "when is the next
/// occurrence" from — see notifications.md. Minimal by design: a single
/// next-occurrence timestamp plus an optional human-readable recurrence
/// description, not a full RRULE engine, since v1 only needs two known
/// recurring meetups (concept.md section 1), not general calendaring.
pub struct EventSchedule {
    next_occurrence_at: DateTime<Utc>,
    recurrence_note: Option<String>,  // e.g. "every Wednesday, 7pm ET" — display only
}

pub struct ProjectLead {
    volunteer_id: VolunteerId,
    role: LeadRole,                  // Lead | CoLead (ADR-0005's `role` column, currently just labels)
    assigned_at: DateTime<Utc>,
}
```

`ProjectLead` is an **entity within the `Project` aggregate**, not its own
aggregate: "who can approve for this project" must be strongly consistent
with the project it governs (no reading a stale lead list while approving
hours), and the collection is always small. This maps directly onto
ADR-0005's `project_lead` table — the aggregate's in-memory shape and the
table are the same granularity, no impedance mismatch at the repository
boundary.

### Invariants

1. **A `Project` must have at least one lead at all times.** The last
   `ProjectLead` cannot be removed; removing a lead when only one remains
   is a domain error (`ProjectError::CannotRemoveLastLead`), not merely a
   UI-level guard.
2. **`project_type` is immutable after creation.** A project cannot be
   converted from `Event` to `Project` or back. This is deliberate: it
   prevents retroactively changing the hour-eligibility of existing
   Assignments (see the event-hours decision) by reclassifying a project
   after volunteers have already been assigned under one interpretation.
3. Only an `Open` project accepts new Assignments (`Project::apply` is the
   only path into `Assignment` construction and checks this).
4. `name` non-empty; `needed_skills` may be empty (a project can be
   open without published skill needs, e.g. a new event).
5. `schedule` is `Some` if and only if `project_type == Event` — a
   standing-project cannot carry a recurrence, and an event cannot lack
   one, since Notifications' "meeting reminder" trigger
   (see [notifications.md](./notifications.md)) depends on every event
   having a `next_occurrence_at` to query against.

### Domain events

- `ProjectCreated { project_id, name, project_type, initial_lead }` —
  implements `AuditableEvent` (action: `Created`, entity_type: `Project`).
- `ProjectLeadAdded { project_id, volunteer_id }` — `AuditableEvent`
  (action: `Updated`).
- `ProjectLeadRemoved { project_id, volunteer_id }` — `AuditableEvent`
  (action: `Updated`); construction fails per invariant 1 rather than ever
  emitting this as the last lead.
- `ProjectClosed { project_id }` — `AuditableEvent` (action: `Updated`).

### Repository port

```rust
#[async_trait]
pub trait ProjectRepository: Send + Sync {
    async fn find_by_id(
        &self, tx: &mut Transaction<'_, Postgres>, id: ProjectId,
    ) -> Result<Option<Project>, RepoError>;

    async fn find_open_by_skill(
        &self, tx: &mut Transaction<'_, Postgres>, skill: &Skill,
    ) -> Result<Vec<ProjectSummary>, RepoError>;   // read model for directory browsing

    async fn find_led_by(
        &self, tx: &mut Transaction<'_, Postgres>, volunteer_id: VolunteerId,
    ) -> Result<Vec<ProjectSummary>, RepoError>;   // backs the `LeadOf` extractor (ADR-0002)

    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, project: &Project,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;  // returns events for the
                                                          // caller to hand to the
                                                          // audit/outbox framework
}
```

The transaction is always caller-supplied (the `apps/api` scoped-transaction
helper, per ADR-0004) — this repository never opens its own connection, so
it cannot bypass `SET LOCAL app.current_user_id`.

### `LeadMembershipQuery` port (consumed by Hours & Verification and the Axum `LeadOf` extractor)

```rust
#[async_trait]
pub trait LeadMembershipQuery: Send + Sync {
    async fn is_lead_of_project(
        &self, tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId, project_id: ProjectId,
    ) -> Result<bool, RepoError>;
}
```

Implemented by this context, injected into `hours-verification`'s command
handlers and into the `apps/api` `LeadOf` extractor — one implementation,
two consumers, per the [context-map.md](./context-map.md) direct-call
mechanism.

### `UpcomingEventOccurrencesQuery` port (consumed by Notifications)

Backs `concept.md` section 7's "meeting reminder" trigger — see
[notifications.md](./notifications.md), which runs a scheduled job against
this port rather than reacting to a domain event, since a reminder is
time-based, not a reaction to a state change.

```rust
#[async_trait]
pub trait UpcomingEventOccurrencesQuery: Send + Sync {
    async fn find_occurring_within(
        &self, tx: &mut Transaction<'_, Postgres>, window: Duration,
    ) -> Result<Vec<EventOccurrence>, RepoError>;
}

pub struct EventOccurrence {
    pub project_id: ProjectId,
    pub project_name: String,
    pub next_occurrence_at: DateTime<Utc>,
    pub attendee_ids: Vec<VolunteerId>,   // every volunteer with an Approved
                                           // Assignment against this event
                                           // Project, both Attendee- and
                                           // Contributor- (host) mode — the
                                           // reminder is not gated by the
                                           // event-hours distinction, since
                                           // everyone who signed up should
                                           // be reminded regardless of
                                           // whether their attendance
                                           // accrues hours
}
```

Implemented against `project`/`assignment` joined on `status = Approved`
and `project.schedule.next_occurrence_at` falling inside the queried
window — a straightforward read model, no new aggregate. Whichever
`ProjectRepository`-adjacent module implements this is also responsible
for tracking, per occurrence, that a reminder job has swept it (see
[notifications.md](./notifications.md)'s idempotency section for the
dedup key — `(recipient, project_id, next_occurrence_at)` — which lives in
Notifications' own `NotificationAttempt` record, not here; this port only
answers "what's coming up," not "who's already been reminded").

## Aggregate: `Assignment`

A separate aggregate from `Project` — different lifecycle (apply → approve
→ active → removed/reassigned), higher write volume, and no need for
`Project` and `Assignment` to be saved atomically together.

```rust
pub struct Assignment {
    id: AssignmentId,
    volunteer_id: VolunteerId,
    project_id: ProjectId,
    role: String,                          // free-text role label, e.g. "Frontend contributor", "Host"
    participation_mode: ParticipationMode, // set once at construction, immutable
    status: AssignmentStatus,              // Applied | Approved | Removed
    applied_at: DateTime<Utc>,
    decided_by: Option<VolunteerId>,
    decided_at: Option<DateTime<Utc>>,
}

pub enum ParticipationMode { Contributor, Attendee }
pub enum AssignmentStatus { Applied, Approved, Removed }
```

### The event-hours invariant, enforced at construction

```rust
impl Assignment {
    /// The only constructor. Takes a `Project` reference (not just an id) so
    /// `participation_mode` can never be set inconsistently with the
    /// project it belongs to.
    pub fn apply(
        project: &Project,
        volunteer_id: VolunteerId,
        role: String,
    ) -> Result<Assignment, AssignmentError> {
        if project.status != ProjectStatus::Open {
            return Err(AssignmentError::ProjectNotOpen);
        }

        let participation_mode = match project.project_type {
            ProjectType::Project => ParticipationMode::Contributor,
            ProjectType::Event => {
                let is_host = project.leads.iter()
                    .any(|l| l.volunteer_id == volunteer_id);
                if is_host { ParticipationMode::Contributor }
                else { ParticipationMode::Attendee }
            }
        };

        Ok(Assignment {
            id: AssignmentId::new(),
            volunteer_id,
            project_id: project.id,
            role,
            participation_mode,
            status: AssignmentStatus::Applied,
            applied_at: Utc::now(),
            decided_by: None,
            decided_at: None,
        })
    }
}
```

This is the concrete mechanism the event-hours decision in
[context-map.md](./context-map.md) requires: `participation_mode` cannot
be set any other way (the field has no public setter), and it is computed
from live `Project` state at the moment of assignment, not guessed at or
defaulted in the application layer. An event-type Project's ordinary
attendee gets `Attendee`; that same project's lead/host gets `Contributor`
because they appear in `project.leads`. A volunteer promoted to lead
*after* an existing `Attendee` assignment is unaffected retroactively —
they'd need a new Assignment (e.g. "Host" role) to accrue hours going
forward, which is the correct behavior: past attendance doesn't
retroactively become hour-eligible just because someone later becomes a
host.

`hours-verification.md` enforces the other half of this same invariant:
`HourEntry` construction is refused unless the referenced `Assignment`'s
`participation_mode` is `Contributor`.

### Other invariants

- Only `Applied` assignments can transition to `Approved` or `Removed`.
- `decided_by` must be a current lead of `project_id` at decision time —
  enforced by the `apps/api` `LeadOf` extractor before the command handler
  is ever invoked (ADR-0002), re-checked in the domain layer via
  `LeadMembershipQuery` for any handler (e.g. bulk actions) that doesn't
  go through a single-project extractor.
- Reassignment (`concept.md` section 4's "remove and reassign") is
  modeled as `Removed` on the old `Assignment` plus a new `Assignment` via
  `Project::apply` again — not a mutation of role/project on the existing
  row, so the audit trail shows two discrete events rather than an
  ambiguous in-place edit.

### Domain events

- `AssignmentApplied { assignment_id, volunteer_id, project_id, participation_mode }`
  — `AuditableEvent` (action: `Created`, entity_type: `Assignment`).
- `AssignmentApproved { assignment_id, decided_by }` — `AuditableEvent`
  (action: `Updated`). Also relevant to Notifications ("assignment
  approved" trigger) and Discord Integration (role reconcile should pick
  up the new project role) — written to the outbox as well as audit_log.
- `AssignmentRemoved { assignment_id, decided_by, reason: Option<String> }`
  — `AuditableEvent` (action: `Deleted` in the audit-log sense, though the
  row is soft-removed via `status`, not physically deleted).

### Repository port

```rust
#[async_trait]
pub trait AssignmentRepository: Send + Sync {
    async fn find_by_id(
        &self, tx: &mut Transaction<'_, Postgres>, id: AssignmentId,
    ) -> Result<Option<Assignment>, RepoError>;

    async fn find_by_project(
        &self, tx: &mut Transaction<'_, Postgres>, project_id: ProjectId,
    ) -> Result<Vec<Assignment>, RepoError>;       // roster view

    async fn find_by_volunteer(
        &self, tx: &mut Transaction<'_, Postgres>, volunteer_id: VolunteerId,
    ) -> Result<Vec<Assignment>, RepoError>;

    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, assignment: &Assignment,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}
```

## Design note: why `Project`, not `Project` + `Event`

`research-findings.md` posed this as a binary schema choice (dual nullable
FKs on Assignment vs. a discriminator). The reporting requirement in
`concept.md` section 8 — "hours report by project and date range" — is the
deciding factor: that report joins `HourEntry → Assignment → Project`. If
`Event` were a separate aggregate/table, every hours or roster query that
should logically span "everything a volunteer is assigned to" would need
either a `UNION` across two tables or two round-trips merged in the
application layer, permanently, for the life of the system — a recurring
tax paid by every future query, not a one-time modeling cost. A
discriminator keeps `Assignment.project_id` a single foreign key and every
downstream join path (roster, hours report, verification letter rollups)
uniform, at the cost of `Project` carrying a few event-only concerns
(no `needed_skills` requirement, typically no approval-heavy applicant
queue). That cost is small and contained to this one aggregate; the
alternative's cost compounds across every context that queries
assignments.
