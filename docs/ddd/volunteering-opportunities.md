# Volunteering & Opportunities

Schema: `volunteering` · Strategic classification: **Core** (see `00-context-map.md` §2)

## Purpose & Scope

Volunteering & Opportunities owns the actual work of the platform: posting
volunteer **Opportunities**, scheduling **Shifts** against them, letting people
**Apply**, and turning time spent into grant-defensible **Hour Entries** through a
submit → approve/reject workflow. Per research 05, hour entries are the
compliance-critical artifact here — they must be immutable once approved, carry an
approver identity and timestamp, and be exportable for grant reporting valued at
the Independent Sector volunteer-hour rate.

In scope:
- Opportunity lifecycle (draft → published → closed/archived), optionally
  chapter-scoped and optionally gated behind Training prerequisites.
- Shift scheduling, capacity, and cancellation.
- Application lifecycle (apply → accept/waitlist/decline → withdraw), including
  waitlist promotion when capacity frees up.
- Hour Entry submission and the approve/reject workflow, with immutability once
  approved.
- Grant-ready export of approved hours.

Explicitly out of scope: awarding points for approved hours (owned by
`gamification`, triggered by the `HoursApproved` event this context publishes),
background-check/screening gating (research 05: likely out of scope for MVP, but a
per-opportunity screening-requirement slot is left for later), and rendering the
activity feed post that results from an approval (owned by `community`).

## Ubiquitous Language

| Term | Definition |
|---|---|
| Opportunity | A posted volunteer task or role, optionally chapter-scoped, optionally requiring completion of specific Training courses before a person may apply. |
| Shift | A scheduled instance of an Opportunity with a start/end time and a capacity — the thing a Person actually applies to. |
| Application | A Person's request to fill a Shift, moving through `pending → accepted \| waitlisted \| declined`, or `→ withdrawn` by the applicant. |
| Hour Entry | A record of time a Person spent volunteering, moving through `submitted → approved \| rejected`. **Immutable once approved.** |
| Approver | The Person (holding `chapter_lead`, `mentor`, or `org_admin`, scoped to the relevant chapter) who approves or rejects a submitted Hour Entry. |
| Grant Export | A filtered, CSV/PDF-ready extract of approved Hour Entries for a date range and/or program, valued at a configurable hourly rate, for funder/board reporting. |
| Waitlist Promotion | The automatic transition of the earliest `waitlisted` Application to `accepted` when an `accepted` Application is declined or withdrawn and capacity frees up. |
| Prerequisite Course | A Training-context course ID referenced (by ID only) on an Opportunity; completion is checked via a cross-context query before an Application is accepted. |

## Aggregates, Entities & Value Objects

Opportunity, Shift, Application, and HourEntry are each modeled as **separate
aggregate roots** (not one giant Opportunity aggregate containing everything),
because each has an independent lifecycle and independent concurrency needs — most
importantly, `Shift` capacity and `Application` acceptance must be transactionally
consistent with each other without pulling the entire Opportunity (and all its
other shifts) into that transaction's lock scope. All four live in the same
`volunteering` schema, so references between them **are** real foreign keys — the
"no FK" rule applies only at bounded-context (schema) boundaries, not within one.

### Opportunity (aggregate root)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `chapterId` | `string \| null` | Plain ID reference to `identity.chapters.id` — **no FK** (cross-schema). `null` = org-wide opportunity. |
| `title` | `string` | |
| `description` | `string` | |
| `category` | `string` | e.g. `"chapter-organizing" \| "content-creation" \| "code-contribution" \| "event-support" \| "coaching"`. |
| `skillsRequired` | `string[]` | Free-text tags. |
| `locationType` | `"in_person" \| "remote" \| "hybrid"` | |
| `minAge` | `int` | Defaults to 16 (platform-wide age gate); may be raised per opportunity. |
| `prerequisiteCourseIds` | `string[]` | Plain IDs referencing `training.courses.id` — **no FK** (cross-schema); checked via Training's `hasCompletedRequiredTraining` query. |
| `createdByPersonId` | `string` | Plain ID reference to `identity.persons.id` — **no FK**. |
| `status` | `"draft" \| "published" \| "closed" \| "archived"` | See state machine below. |
| `publishedAt` | `DateTime \| null` | |
| `closedAt` | `DateTime \| null` | |
| `createdAt` / `updatedAt` | `DateTime` | |

**Opportunity status state machine:**

```
draft --publish--> published --close--> closed --archive--> archived
  ^                     |
  |                     +--(edit non-schedule fields freely)
  +--(no transitions back into draft once published)
```

**Invariants:**
1. `publish` requires non-empty `title`, `description`, and `chapterId` either
   `null` (org-wide) or referencing a chapter believed active (checked via
   Identity's Open Host Service at publish time, not enforced by FK).
2. Once `published`, `status` never returns to `draft`.
3. `close` and `archive` do not delete or invalidate existing `Shift`,
   `Application`, or `HourEntry` rows — historical shifts under a closed
   Opportunity remain queryable for reporting.
4. An Opportunity cannot be `archive`d while it has any `Shift` with `status =
   'scheduled'` — cancel or complete those first.

### Shift (aggregate root)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `opportunityId` | `string` | FK to `Opportunity.id` (same schema — real FK). |
| `startsAt` | `DateTime` | |
| `endsAt` | `DateTime` | |
| `timezone` | `string` | IANA zone name. |
| `capacity` | `int` | ≥ 1. |
| `acceptedCount` | `int` | Denormalized counter, maintained transactionally alongside `Application` transitions (see invariant 3). |
| `status` | `"scheduled" \| "cancelled" \| "completed"` | |
| `createdAt` / `updatedAt` | `DateTime` | |

**Invariants:**
1. `endsAt > startsAt`.
2. `capacity ≥ 1`; `capacity` may not be reduced below the current
   `acceptedCount`.
3. `acceptedCount` is updated **in the same transaction** as any `Application`
   transition into/out of `accepted`, and must never exceed `capacity` — this is
   the concurrency-sensitive invariant that justifies `Shift` being its own
   aggregate (accept/decline races on one shift must serialize independent of
   activity on any other shift under the same Opportunity).
4. A `Shift` with any `HourEntry` in status `approved` cannot transition to
   `cancelled` — it may only reach `completed`.

### Application (aggregate root)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `shiftId` | `string` | FK to `Shift.id` (same schema). |
| `applicantPersonId` | `string` | Plain ID reference to `identity.persons.id` — **no FK**. |
| `status` | `"pending" \| "accepted" \| "waitlisted" \| "declined" \| "withdrawn"` | See state machine below. |
| `appliedAt` | `DateTime` | |
| `decidedByPersonId` | `string \| null` | Plain ID reference to `identity.persons.id` — **no FK**. |
| `decidedAt` | `DateTime \| null` | |
| `decisionNote` | `string \| null` | |

**Application status state machine:**

```
pending --accept-->  accepted --withdraw--> withdrawn
   |                    ^
   |--waitlist-->  waitlisted --(capacity frees up)--> accepted
   |                    |
   +--decline--> declined <--decline--+
```

**Invariants:**
1. A given `(applicantPersonId, shiftId)` pair may have at most one **non-terminal
   or accepted** Application — re-applying after `declined`/`withdrawn` creates a
   new row; applying while a `pending`/`accepted`/`waitlisted` row already exists
   is rejected.
2. Transitioning to `accepted` requires, in the same transaction, incrementing
   `Shift.acceptedCount` and verifying `acceptedCount ≤ capacity` (see Shift
   invariant 3) — if capacity is already full, the transition goes to
   `waitlisted` instead.
3. `withdraw` is only callable by the applicant themself, and only from
   `pending`/`accepted`/`waitlisted`; `withdraw` from `accepted` decrements
   `Shift.acceptedCount` and triggers **Waitlist Promotion** (earliest
   `waitlisted` row by `appliedAt`, if any, moves to `accepted`) in the same
   transaction.
4. `accept`/`decline`/`waitlist` may only be performed by someone authorized to
   approve applications for this Shift's Opportunity (`chapter_lead`/`mentor`
   scoped to the Opportunity's chapter, or `org_admin`) — enforced via the shared
   `can()` policy module.
5. Accepting an Application requires the applicant to satisfy the parent
   Opportunity's `prerequisiteCourseIds`, verified via Training's
   `hasCompletedRequiredTraining` query at decision time (an in-request check —
   see `00-context-map.md` row 14).

### HourEntry (aggregate root)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `personId` | `string` | Plain ID reference to `identity.persons.id` — **no FK**. |
| `opportunityId` | `string` | FK to `Opportunity.id` (same schema). |
| `shiftId` | `string \| null` | FK to `Shift.id` (same schema); nullable — hours may be logged for ad hoc volunteering not tied to a specific scheduled shift. |
| `startAt` | `DateTime` | |
| `endAt` | `DateTime` | |
| `durationMinutes` | `int` | Stored, not purely derived — see invariant 1 (value object `DurationMinutes`). |
| `description` | `string \| null` | Free text the volunteer supplies describing the work done. |
| `status` | `"submitted" \| "approved" \| "rejected"` | Terminal once `approved`; see invariants. |
| `submittedAt` | `DateTime` | |
| `approverPersonId` | `string \| null` | Plain ID reference to `identity.persons.id` — **no FK**. Required once `approved` or `rejected`. |
| `approvedAt` / `rejectedAt` | `DateTime \| null` | |
| `rejectionReason` | `string \| null` | Required when `status = 'rejected'`. |

**HourEntry status state machine (terminal on approval):**

```
submitted --approve--> approved   [TERMINAL — no further mutation permitted]
    |
    +-------reject----> rejected  [terminal for this row; volunteer may submit a NEW entry, never reopen this one]
```

**Invariants:**
1. `durationMinutes = (endAt - startAt) in minutes`, computed at submission and
   stored (not recomputed on read) so an approved record's reported duration can
   never silently drift; `0 < durationMinutes ≤ 1440` (a single entry cannot span
   more than 24 hours — longer volunteering must be logged as multiple entries).
2. `approve`/`reject` requires `approverPersonId` to hold `chapter_lead`,
   `mentor`, or `org_admin` scoped to the Opportunity's chapter (or `org_admin`
   globally) — verified via `can()` — and **the approver may not be the same
   Person as `personId`** (no self-approval).
3. **Once `status = 'approved'`, the row is immutable** — no field may be
   updated thereafter, enforced both at the application/repository layer and by
   a database trigger (see Schema Sketch) as defense-in-depth. A correction to an
   approved entry requires a new, separate `HourEntry` (optionally negative-net
   via a documented adjustment convention at the reporting layer) — never an
   edit or delete of the original, because grant reporting must be able to
   reconstruct exactly what was approved and when.
4. `reject` requires a non-empty `rejectionReason`.
5. A `HourEntry` referencing a `shiftId` must have `startAt`/`endAt` falling
   within a reasonable window of that Shift's `startsAt`/`endsAt` (validated at
   submission, not DB-enforced, to allow reasonable early-arrival/overrun
   tolerance configured at the application layer).

## Domain Events

| Event | Payload fields | Emitted when | Consumed by |
|---|---|---|---|
| `OpportunityPublished` | `opportunityId, chapterId, title, category, publishedAt` | `PublishOpportunity` transitions `draft → published`. | Community, Notifications, Admin. |
| `ShiftScheduled` | `shiftId, opportunityId, startsAt, endsAt, capacity` | `ScheduleShift` commits a new Shift. | Notifications, Community. |
| `ShiftCancelled` | `shiftId, opportunityId, cancelledAt, reason` | `CancelShift` commits. | Notifications, Community. |
| `ApplicationSubmitted` | `applicationId, shiftId, applicantPersonId, appliedAt` | `ApplyToShift` commits a new pending Application. | Notifications. |
| `ApplicationAccepted` | `applicationId, shiftId, opportunityId, applicantPersonId, decidedAt` | `DecideApplication` (or waitlist promotion) transitions to `accepted`. | Community, Notifications, Gamification. |
| `ApplicationWaitlisted` | `applicationId, shiftId, applicantPersonId, decidedAt` | `DecideApplication` transitions to `waitlisted`. | Notifications. |
| `ApplicationDeclined` | `applicationId, shiftId, applicantPersonId, decidedAt, decisionNote` | `DecideApplication` transitions to `declined`. | Notifications. |
| `ApplicationWithdrawn` | `applicationId, shiftId, applicantPersonId, withdrawnAt` | `WithdrawApplication` commits. | Notifications, Community. |
| `HoursSubmitted` | `hourEntryId, personId, opportunityId, shiftId, durationMinutes, submittedAt` | `SubmitHours` commits. | Notifications (alert the approver). |
| **`HoursApproved`** | `hourEntryId, personId, opportunityId, shiftId, chapterId, durationMinutes, approverPersonId, approvedAt` | `ApproveHours` transitions `submitted → approved`. | **Gamification** (awards points from approved hours — see `00-context-map.md` row 12), Community (feed post), Notifications (confirmation), Admin (grant-reporting projection). |
| `HoursRejected` | `hourEntryId, personId, opportunityId, approverPersonId, rejectedAt, rejectionReason` | `RejectHours` commits. | Notifications. |

`HoursApproved` is the single most important **outbound** event this context
publishes: it is the trigger the entire points-awarding side of the product
depends on, and it is deliberately the *only* way points get awarded from
volunteering activity — `gamification` never queries `volunteering.hour_entries`
directly (no cross-schema FK, no cross-schema join), it only ever reacts to this
event, keeping "hours approved" and "points awarded" eventually consistent by
design (ADR-0001).

## Key Use Cases / Application Services

1. **PublishOpportunity**
   - *Pre:* Opportunity exists in `draft` with non-empty `title`/`description`;
     caller holds `chapter_lead` (for the target chapter) or `org_admin`.
   - *Post:* `status = 'published'`, `publishedAt` set; `OpportunityPublished`
     emitted.

2. **ScheduleShift**
   - *Pre:* Parent Opportunity is `published`; `endsAt > startsAt`;
     `capacity ≥ 1`.
   - *Post:* New `Shift(status='scheduled', acceptedCount=0)` row exists;
     `ShiftScheduled` emitted.

3. **CancelShift**
   - *Pre:* No `HourEntry` referencing this shift is `approved` (see Shift
     invariant 4).
   - *Post:* `status = 'cancelled'`; all non-terminal Applications on this shift
     transition to `declined` with an auto-generated `decisionNote`;
     `ShiftCancelled` emitted.

4. **ApplyToShift**
   - *Pre:* Shift is `scheduled` and in the future; applicant has no existing
     non-terminal/accepted Application for this shift; applicant meets
     `Opportunity.minAge` (checked via Identity's Person data at application
     time).
   - *Post:* New `Application(status='pending')` row exists; `ApplicationSubmitted`
     emitted.

5. **DecideApplication** (accept / decline / waitlist)
   - *Pre:* Caller is authorized to decide applications for this Opportunity
     (`can()` check); if deciding `accept`, the applicant satisfies
     `prerequisiteCourseIds` (Training query) and `Shift.acceptedCount <
     capacity` — otherwise the decision is forced to `waitlisted` instead of
     `accepted`.
   - *Post:* `Application.status` updated with `decidedByPersonId`/`decidedAt`;
     if `accepted`, `Shift.acceptedCount` incremented in the same transaction;
     corresponding event (`ApplicationAccepted`/`ApplicationWaitlisted`/
     `ApplicationDeclined`) emitted.

6. **WithdrawApplication**
   - *Pre:* Caller is the applicant; Application is `pending`/`accepted`/
     `waitlisted`.
   - *Post:* `status = 'withdrawn'`; if it was `accepted`,
     `Shift.acceptedCount` decremented and **Waitlist Promotion** runs in the
     same transaction (earliest `waitlisted` row by `appliedAt`, if capacity now
     allows, becomes `accepted` and emits its own `ApplicationAccepted`);
     `ApplicationWithdrawn` emitted.

7. **SubmitHours**
   - *Pre:* Caller is the person the hours are logged for; `endAt > startAt`;
     `durationMinutes ≤ 1440`.
   - *Post:* New `HourEntry(status='submitted')` row exists; `HoursSubmitted`
     emitted.

8. **ApproveHours**
   - *Pre:* `HourEntry.status = 'submitted'`; caller holds `chapter_lead`,
     `mentor`, or `org_admin` scoped to the entry's Opportunity's chapter;
     caller ≠ `personId` (no self-approval).
   - *Post:* `status = 'approved'`, `approverPersonId`/`approvedAt` set; row
     becomes immutable (see invariant 3); `HoursApproved` emitted.

9. **RejectHours**
   - *Pre:* `HourEntry.status = 'submitted'`; caller authorized as above;
     non-empty `rejectionReason` supplied.
   - *Post:* `status = 'rejected'`, `approverPersonId`/`rejectedAt`/
     `rejectionReason` set; `HoursRejected` emitted.

10. **ExportApprovedHours** (grant report)
    - *Pre:* Caller holds `org_admin` or `chapter_lead` (scoped to the requested
      chapter, if any filter is applied).
    - *Post:* A CSV/PDF is generated from `status = 'approved'` `HourEntry` rows
      filtered by date range and/or `opportunityId`/`chapterId`, joined (at the
      application/read-model layer, not via SQL join) against `identity`'s
      denormalized person/chapter display projection, valued at a configurable
      hourly rate; no state change, read-only.


> Schema DDL, tRPC/REST API contract, and integration notes for this context continue in [volunteering-opportunities-schema-api.md](volunteering-opportunities-schema-api.md).
