# ADR 0006: Assignment/Event Model and Event-Hours Semantics

## Status

Accepted — 2026-08-19. **Amended — 2026-08-19**: the event-hours rule
below was refined from a blanket exclusion to a
Contributor/Attendee distinction, reconciling this ADR with the
domain model in `.plans/ddd/` (`context-map.md`,
`projects-assignments.md`, `hours-verification.md`), which surfaced a
real gap the original blanket rule missed. The schema-shape decision
(discriminator column, not dual FKs) is unchanged by this amendment.

## Context

`concept.md` says volunteers are assigned "to project or event" but does
not specify the implementation, and does not say whether event
(meetup) attendance accrues verification-letter-eligible hours.
`research-findings.md` identifies two separate but related open
questions:

1. **Implementation shape**: nullable dual foreign keys on `Assignment`
   (`project_id`, `event_id`, exactly one non-null) vs. a discriminator
   column. The research pass recommends collapsing `Event` into `Project`
   with a `type` discriminator, keeping `HourEntry → Assignment →
   Project` a single join path for both browsing and reporting.
2. **Product semantics**: does meetup attendance count toward the hours
   total that appears on a verification letter? This is a binary decision
   with real schema and approval-model consequences that
   research-findings.md explicitly left open. It must be resolved here,
   not left as a placeholder — build-roadmap.md's Phase 0 exit criteria
   require it.

The original version of this ADR resolved (2) as a blanket "no" for all
event attendance. The subsequent DDD pass (`.plans/ddd/`) identified a
real gap in that blanket rule while reading it against
[[0005-audit-log-and-co-leads]]: `concept.md` section 1 explicitly seeds
the initial `lead` accounts from "the current meeting hosts" — meaning
the people who run the weekly volunteer meetup and the marketing meeting
are *leads*, not ordinary attendees, and hosting a recurring meetup
(prep, running it, follow-up) is real volunteer effort indistinguishable
in kind from project work. A blanket "events never accrue hours" rule
would have made a lead's own meetup-hosting time permanently
unloggable, with no workaround other than the "create a synthetic
project" pattern this ADR's original text suggested — an awkward,
avoidable outcome for exactly the volunteers `concept.md` most clearly
intends to recognize as doing real work. This amendment adopts the DDD
pass's more granular rule instead.

## Decision

**Schema shape:** `Project` gets a `type` discriminator column:
`type IN ('project', 'event')`. `Assignment.project_id` is a single FK to
`Project` regardless of type — there are no dual nullable FKs. Event-
specific fields (e.g. a single `event_date`, vs. a project's open-ended
`start_date`) live as nullable columns on `Project`, used only when
`type = 'event'`. `HourEntry → Assignment → Project` remains one join
path for both types, satisfying the research pass's recommendation to
avoid duplicate query/reporting logic.

**Event-hours semantics (amended): ordinary event attendees never accrue
hours; the event's own lead/host does.**

Rationale: concept.md section 5 describes events (the weekly volunteer
meetup, the marketing meeting) as needing "signup and attendance
tracking," explicitly distinct from the hours-and-verification-letter
system described in the same section for project work — that part of
the original rationale still holds for ordinary attendees. Verification
letters exist to document substantive volunteer contribution for
external purposes (e.g. school/employer requirements), and passive
attendance at a recurring internal meetup remains a different kind of
record (participation, not contribution-hours) that must not inflate a
letter's project-hours total. But concept.md section 1 already treats
meeting hosts as `lead` accounts, not attendees, and hosting a recurring
meetup is real, substantive effort — the same kind of contribution the
letter exists to document. Excluding it categorically because it happens
to be attached to an `event`-type `Project` was an over-generalization in
the original version of this ADR; the correct line is between
*contributing* effort and *attending* — not between `project`-type and
`event`-type projects.

**Mechanism: `Assignment` carries a `participation_mode` field —
`Contributor | Attendee` — set once at construction and immutable
thereafter, computed from `(Project.project_type, is this volunteer one
of the Project's leads at the moment of assignment)`:**

| `Project.project_type` | Volunteer is a project lead? | `participation_mode` |
|---|---|---|
| `project` | (irrelevant — always a contributor) | `Contributor` |
| `event` | yes | `Contributor` |
| `event` | no | `Attendee` |

`HourEntry` construction is refused for any `Assignment` whose
`participation_mode` is not `Contributor` — this is the single point
where the invariant is enforced; every downstream consumer (verification
letters, hours reports, Notifications' "hours approved" trigger, Discord
role sync) inherits the correct exclusion automatically because
`Attendee`-mode assignments simply cannot have `HourEntry` rows, rather
than each consumer needing its own event-type filter. See
`.plans/ddd/projects-assignments.md` (`Assignment::apply`) and
`.plans/ddd/hours-verification.md` (`HourEntry::log`) for the exact
constructor signatures — this ADR states the rule and its rationale; the
DDD documents are the binding implementation contract for it and must
not be reinterpreted independently of this ADR or of each other.

A volunteer promoted to lead *after* an existing `Attendee`-mode
assignment is **not** retroactively upgraded — past attendance does not
become hour-eligible after the fact. They need a new `Assignment` (e.g.
a "Host" role, created going forward) to accrue hours, which is the
correct behavior: `participation_mode` reflects the role the volunteer
actually held at the time of that specific assignment, not their current
status.

This is enforced as a **hard constraint, not a UI-only rule**, at two
layers per the defense-in-depth pattern established in
[[0004-orm-and-row-level-security]]:
- **Application layer (primary):** `HourEntry`'s only constructor
  (`HourEntry::log`) refuses to build against any `AssignmentSnapshot`
  whose `participation_mode` is not `Contributor`, returning a typed
  `HourEntryError::AssignmentNotEligibleForHours` the API layer maps to a
  clean 4xx response.
- **Database layer (defense in depth):** a Postgres trigger on
  `hour_entry` (a plain `CHECK` constraint cannot reference another
  table) that joins through `assignment` and rejects the write if the
  referenced assignment's computed `participation_mode` is not
  `Contributor`. The exact trigger SQL is Phase 1 implementation detail;
  this ADR specifies that it must exist, mirroring the application-layer
  rule rather than reintroducing a separate, potentially divergent rule.

Ordinary (`Attendee`-mode) event `Assignment` rows continue to exist
solely to record signup and attendance (a boolean or timestamp
`attended_at` on `Assignment`), with no approval workflow needed for that
mode — attendance is either recorded or not. `Contributor`-mode event
assignments (the host/lead) use the same approval and hour-logging flow
as any project assignment; no separate approval model is needed for
them, since they are, by this rule, just contributors.

**Revisiting this decision further:** if the Foundation later wants
*ordinary* attendees to also accrue hours (e.g. for volunteers logging
significant setup/teardown time even without a lead role), the change is
localized to the `participation_mode` computation in
`Assignment::apply` — `HourEntry::log`'s invariant does not need to
change at all, since it only ever inspects `participation_mode` and has
no separate opinion about event-type projects. This is a deliberate
consequence of enforcing the rule once, on `Assignment` construction,
rather than duplicating an event-type check inside `HourEntry` itself.

## Consequences

**Positive:**
- Single join path (`HourEntry → Assignment → Project`) for both
  browsing and reporting avoids duplicated query logic across the
  codebase — directly benefits Phase 8's hours-report and CSV-export
  work. Unchanged by the amendment.
- The event-hours decision is unambiguous and enforced at both the
  application layer (construction-time invariant, the primary
  enforcement point) and the database layer (trigger, defense in depth)
  — a lead cannot accidentally approve event-attendance hours for an
  `Attendee`-mode assignment that later appear on a verification letter,
  even if a future UI bug allows submitting such a request.
- Verification letters (Phase 6) and hours reports (Phase 8) can be
  generated with a simple query over `hour_entry` with no event-type
  filtering logic of their own: because `HourEntry` can only ever be
  constructed against a `Contributor`-mode `Assignment`, every row in
  `hour_entry` is already correctly scoped by construction, whether it
  traces back to a `project`-type `Project` or an `event`-type
  `Project`'s host. This is a stronger and simpler guarantee than the
  original blanket rule offered, not a weaker one — the exclusion logic
  lives in exactly one place (`Assignment` construction) instead of
  needing to be re-derived at every read site.
- Closes the gap the blanket rule left open: a meetup host's real,
  substantive volunteer effort is now correctly recognized as
  hour-eligible, consistent with `concept.md` treating meeting hosts as
  `lead` accounts rather than as ordinary participants.

**Negative / accepted risk:**
- A `Project`-with-`type`-discriminator model means some columns are
  meaningful only for one type (e.g. `needed_skills` for projects,
  `event_date` for events) — a normalization compromise accepted in
  exchange for the single-join-path benefit. Reviewed against the
  research pass's explicit recommendation and judged the right tradeoff
  for a lean core schema. Unchanged by the amendment.
- `participation_mode` is fixed at `Assignment` construction time and
  does not retroactively update if a volunteer is later promoted to
  project lead — this is a deliberate design choice (see Decision above)
  but is a real, if minor, UX subtlety: a newly-promoted host must
  receive a new `Assignment` to start accruing hours, rather than their
  existing attendance record simply starting to count. Should be
  reflected in onboarding/help copy for leads when Phase 3/5 UI is built.
- The trigger-based constraint is Postgres-specific logic living outside
  the Rust application layer — a minor consistency departure from
  "authorization/business logic lives in the Rust service," justified
  here because it is a hard data-integrity invariant (not an
  authorization decision) and defense-in-depth against any future code
  path that bypasses the Rust validation. Unchanged by the amendment,
  except that the trigger's condition now mirrors `participation_mode`
  rather than a bare `project.type` check.
- The synthetic-project workaround the original ADR text relied on for
  "the Foundation later wants meetup hours to count" is now unnecessary
  for the lead/host case specifically — it remains the correct path only
  for the narrower, still-open question of whether *ordinary attendees*
  should ever accrue hours (see the "revisiting" note above).

## Alternatives Considered

- **Dual nullable FKs (`Assignment.project_id`, `Assignment.event_id`).**
  Rejected per the research pass — requires `XOR`-style constraints and
  doubles query/reporting logic for no benefit over a discriminator
  column. Unchanged by the amendment.
- **Blanket exclusion: no event-type assignment ever accrues hours,
  including the host/lead** (the original version of this ADR).
  Superseded by this amendment — identified as an over-generalization
  once read against [[0005-audit-log-and-co-leads]] and `concept.md`
  section 1's treatment of meeting hosts as `lead` accounts. Retained
  here for the record rather than deleted, since a future reader
  comparing this ADR against old references to "events never accrue
  hours" should be able to see explicitly what changed and why.
- **Events accrue hours for all attendees, with their own approval
  model.** Rejected — still conflates passive attendance-tracking with
  contribution-hours for the *ordinary attendee* case, which risks the
  integrity of verification letters; the amendment addresses the
  legitimate gap (hosts) without accepting this broader alternative.
- **Events accrue hours but are flagged separately on verification
  letters (shown but distinguished from project hours).** Considered as
  a middle path for the ordinary-attendee case; rejected as unnecessary
  complexity for v1 given no stated product requirement for it in
  concept.md — remains available as a future option via the
  `participation_mode` computation change described above.
- **A per-`HourEntry` or per-request check of `Project.project_type`
  instead of the `Assignment.participation_mode` field.** Rejected —
  would require every consumer (verification letters, hours reports,
  Notifications, Discord sync) to independently know and apply the
  Contributor/Attendee distinction, reintroducing the duplicated-logic
  risk the discriminator-column decision was meant to avoid in the first
  place. Computing and freezing `participation_mode` once, at
  `Assignment` construction, is what lets every downstream consumer stay
  ignorant of event-hours semantics entirely.

## Phase Gate

Unblocks Phase 3 (Projects — schema shape for `Assignment`) and Phase 4
(Hours — event-hours behavior "enforced at the application/schema
boundary, not just in UI copy," per build-roadmap.md's Phase 4 exit
criteria).
