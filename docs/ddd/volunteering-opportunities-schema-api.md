# Volunteering & Opportunities — Schema & API Contract

Continuation of [volunteering-opportunities.md](volunteering-opportunities.md) (Purpose, Ubiquitous Language, Aggregates, Domain Events, and Key Use Cases live there). Split out purely to stay under the repo's 500-line-per-file guideline — this is the same bounded context, same schema `volunteering`.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS volunteering;

CREATE TYPE volunteering.opportunity_status AS ENUM ('draft', 'published', 'closed', 'archived');
CREATE TYPE volunteering.location_type AS ENUM ('in_person', 'remote', 'hybrid');
CREATE TYPE volunteering.shift_status AS ENUM ('scheduled', 'cancelled', 'completed');
CREATE TYPE volunteering.application_status AS ENUM ('pending', 'accepted', 'waitlisted', 'declined', 'withdrawn');
CREATE TYPE volunteering.hour_entry_status AS ENUM ('submitted', 'approved', 'rejected');

CREATE TABLE volunteering.opportunities (
  id                      text PRIMARY KEY,
  chapter_id              text, -- soft reference to identity.chapters.id, no FK
  title                   text NOT NULL,
  description             text NOT NULL,
  category                text NOT NULL,
  skills_required         text[] NOT NULL DEFAULT '{}',
  location_type           volunteering.location_type NOT NULL,
  min_age                 int NOT NULL DEFAULT 16,
  prerequisite_course_ids text[] NOT NULL DEFAULT '{}', -- soft references to training.courses.id
  created_by_person_id    text NOT NULL, -- soft reference to identity.persons.id, no FK
  status                  volunteering.opportunity_status NOT NULL DEFAULT 'draft',
  published_at            timestamptz,
  closed_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_opportunities_publish CHECK (
    status = 'draft' OR (title <> '' AND description <> '')
  )
);
CREATE INDEX idx_opportunities_chapter ON volunteering.opportunities (chapter_id);
CREATE INDEX idx_opportunities_status ON volunteering.opportunities (status);

CREATE TABLE volunteering.shifts (
  id              text PRIMARY KEY,
  opportunity_id  text NOT NULL REFERENCES volunteering.opportunities (id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  timezone        text NOT NULL,
  capacity        int NOT NULL CHECK (capacity >= 1),
  accepted_count  int NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  status          volunteering.shift_status NOT NULL DEFAULT 'scheduled',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_shifts_time_order CHECK (ends_at > starts_at),
  CONSTRAINT chk_shifts_capacity CHECK (accepted_count <= capacity)
);
CREATE INDEX idx_shifts_opportunity ON volunteering.shifts (opportunity_id);
CREATE INDEX idx_shifts_starts_at ON volunteering.shifts (starts_at);

CREATE TABLE volunteering.applications (
  id                    text PRIMARY KEY,
  shift_id              text NOT NULL REFERENCES volunteering.shifts (id),
  applicant_person_id   text NOT NULL, -- soft reference to identity.persons.id, no FK
  status                volunteering.application_status NOT NULL DEFAULT 'pending',
  applied_at            timestamptz NOT NULL DEFAULT now(),
  decided_by_person_id  text, -- soft reference to identity.persons.id, no FK
  decided_at            timestamptz,
  decision_note         text
);
-- At most one non-terminal/accepted application per (applicant, shift):
CREATE UNIQUE INDEX uq_applications_active_per_shift
  ON volunteering.applications (applicant_person_id, shift_id)
  WHERE status IN ('pending', 'accepted', 'waitlisted');
CREATE INDEX idx_applications_shift ON volunteering.applications (shift_id);
CREATE INDEX idx_applications_applicant ON volunteering.applications (applicant_person_id);

CREATE TABLE volunteering.hour_entries (
  id                   text PRIMARY KEY,
  person_id            text NOT NULL, -- soft reference to identity.persons.id, no FK
  opportunity_id       text NOT NULL REFERENCES volunteering.opportunities (id),
  shift_id             text REFERENCES volunteering.shifts (id),
  start_at             timestamptz NOT NULL,
  end_at               timestamptz NOT NULL,
  duration_minutes     int NOT NULL,
  description          text,
  status               volunteering.hour_entry_status NOT NULL DEFAULT 'submitted',
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  approver_person_id   text, -- soft reference to identity.persons.id, no FK
  approved_at          timestamptz,
  rejected_at          timestamptz,
  rejection_reason     text,
  CONSTRAINT chk_hour_entries_time_order CHECK (end_at > start_at),
  CONSTRAINT chk_hour_entries_duration CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  CONSTRAINT chk_hour_entries_approval CHECK (
    (status = 'approved' AND approver_person_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (status = 'rejected' AND approver_person_id IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)
    OR (status = 'submitted' AND approver_person_id IS NULL)
  ),
  CONSTRAINT chk_hour_entries_no_self_approval CHECK (
    approver_person_id IS NULL OR approver_person_id <> person_id
  )
);
CREATE INDEX idx_hour_entries_person ON volunteering.hour_entries (person_id);
CREATE INDEX idx_hour_entries_opportunity ON volunteering.hour_entries (opportunity_id);
-- Grant-export hot path: approved hours by date range.
CREATE INDEX idx_hour_entries_approved_export
  ON volunteering.hour_entries (approved_at)
  WHERE status = 'approved';

-- Defense-in-depth: block any UPDATE on a row that is already approved.
CREATE OR REPLACE FUNCTION volunteering.prevent_approved_hour_entry_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'hour_entries row % is approved and immutable', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hour_entries_immutable
  BEFORE UPDATE ON volunteering.hour_entries
  FOR EACH ROW EXECUTE FUNCTION volunteering.prevent_approved_hour_entry_mutation();

CREATE TABLE volunteering.domain_events (
  id              text PRIMARY KEY, -- ULID; chronological by construction
  aggregate_type  text NOT NULL,    -- 'Opportunity' | 'Shift' | 'Application' | 'HourEntry'
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,    -- 'OpportunityPublished' | 'HoursApproved' | ...
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0
);
CREATE INDEX idx_volunteering_domain_events_unprocessed
  ON volunteering.domain_events (id) WHERE processed_at IS NULL;
```

## API Contract Sketch

tRPC router `volunteering`, this context's public `index.ts` interface.

```typescript
export const volunteeringRouter = router({
  opportunities: router({
    create: procedure
      .input(z.object({
        chapterId: ulidSchema.nullable(), title: z.string().min(1), description: z.string().min(1),
        category: z.string(), skillsRequired: z.array(z.string()).default([]),
        locationType: z.enum(['in_person', 'remote', 'hybrid']),
        minAge: z.number().int().min(13).default(16),
        prerequisiteCourseIds: z.array(ulidSchema).default([]),
      }))
      .mutation(/* requires can(caller, 'opportunity.create', {chapterId}) -> { opportunityId } */),
    publish: procedure
      .input(z.object({ opportunityId: ulidSchema }))
      .mutation(/* -> void */),
    list: procedure
      .input(z.object({
        chapterId: ulidSchema.optional(), status: z.enum(['published']).default('published'),
        category: z.string().optional(), cursor: ulidSchema.optional(), limit: z.number().max(50).default(20),
      }))
      .query(/* -> { items: Opportunity[], nextCursor: string | null } */),
    getById: procedure
      .input(z.object({ id: ulidSchema }))
      .query(/* -> Opportunity | null */),
  }),

  shifts: router({
    schedule: procedure
      .input(z.object({
        opportunityId: ulidSchema, startsAt: z.string().datetime(), endsAt: z.string().datetime(),
        timezone: z.string(), capacity: z.number().int().min(1),
      }))
      .mutation(/* -> { shiftId } */),
    cancel: procedure
      .input(z.object({ shiftId: ulidSchema, reason: z.string() }))
      .mutation(/* -> void */),
    listByOpportunity: procedure
      .input(z.object({ opportunityId: ulidSchema }))
      .query(/* -> Shift[] */),
  }),

  applications: router({
    apply: procedure
      .input(z.object({ shiftId: ulidSchema }))
      .mutation(/* caller = applicant, taken from session -> { applicationId } */),
    decide: procedure
      .input(z.object({
        applicationId: ulidSchema, decision: z.enum(['accept', 'decline', 'waitlist']),
        decisionNote: z.string().optional(),
      }))
      .mutation(/* -> void */),
    withdraw: procedure
      .input(z.object({ applicationId: ulidSchema }))
      .mutation(/* caller must be the applicant -> void */),
    listForShift: procedure
      .input(z.object({ shiftId: ulidSchema }))
      .query(/* -> Application[] */),
  }),

  hourEntries: router({
    submit: procedure
      .input(z.object({
        opportunityId: ulidSchema, shiftId: ulidSchema.nullable(),
        startAt: z.string().datetime(), endAt: z.string().datetime(),
        description: z.string().optional(),
      }))
      .mutation(/* caller = personId, taken from session -> { hourEntryId } */),
    approve: procedure
      .input(z.object({ hourEntryId: ulidSchema }))
      .mutation(/* -> void */),
    reject: procedure
      .input(z.object({ hourEntryId: ulidSchema, rejectionReason: z.string().min(1) }))
      .mutation(/* -> void */),
    listForPerson: procedure
      .input(z.object({ personId: ulidSchema, status: z.enum(['submitted', 'approved', 'rejected']).optional() }))
      .query(/* -> HourEntry[] */),
    exportApproved: procedure
      .input(z.object({
        chapterId: ulidSchema.optional(), opportunityId: ulidSchema.optional(),
        fromDate: z.string().date(), toDate: z.string().date(),
        hourlyRate: z.number().positive().optional(),
      }))
      .query(/* requires can(caller, 'hours.export') -> { csvUrl: string, totalHours: number, totalValue: number } */),
  }),
});
```

Also exposed under versioned public REST for grant/board tooling that lives outside
the app: `GET /api/v1/hour-entries/export?from=&to=&chapterId=&format=csv|pdf`
(same authorization rule as `exportApproved`, API-key authenticated).

## Integration & Anti-Corruption Notes

- **No direct query into `identity` or `training` tables — ever.** Chapter
  validity, applicant age, and role-based authorization all go through Identity's
  published `getPersonSummary`/role-check surface (or the shared `can()` policy
  module, which itself reads `identity.role_assignments` on Identity's behalf);
  prerequisite-course completion goes through Training's
  `hasCompletedRequiredTraining(personId, courseIds[])` Open Host Service query.
  Both are synchronous, in-request calls (not events) because "can this person
  apply right now" cannot tolerate eventual consistency the way "award points
  later" can.
- **`HoursApproved` is a Published Language, not a command.** This context does
  not call into `gamification` to "award points" — it publishes the fact that
  hours were approved and lets Gamification decide, independently and on its own
  schedule (via `graphile-worker`), how many points that translates to. This
  keeps the point-value rule change-able (`GamificationRuleUpdated`, per the
  context map) without ever touching this context's code.
- **Grant export never joins across schemas.** `ExportApprovedHours` reads only
  `volunteering.hour_entries` and enriches rows with display names/chapter names
  from a denormalized projection this context maintains locally, kept current by
  consuming `identity`'s `PersonRegistered`/`ChapterCreated`/`PersonAnonymized`
  events — never a live cross-schema `JOIN`, consistent with the no-cross-schema-FK
  architecture (ADR-0001).
- **Waitlist promotion and `Shift.acceptedCount` are a within-context
  concurrency boundary**, not a cross-context one — both live in the same
  transaction and the same schema specifically so this hot, contended path (many
  people applying to a popular shift at once) never needs distributed
  coordination.
- **Screening/background-check requirements are a documented future extension
  point, not built now**: `Opportunity` intentionally has no
  `screeningRequirement` field yet (research 05 flags this as likely out of
  scope for MVP for a distributed AI/OSS community) — when needed, it will be
  modeled as a plain reference to a future `identity`-or-new-context screening
  record, following the same by-ID, no-FK pattern as every other cross-context
  reference here.
