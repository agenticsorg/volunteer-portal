# Implementation Prompts — Agentics Foundation Volunteer Portal

Twelve implementation prompts, in build order. Each one is self-contained, paste-ready text for an implementation agent or engineer — copy the fenced block under a phase and hand it over once every phase listed in its "Already built" line is actually done and merged. Don't skip ahead: several prompts assume tables, published read functions, or domain events from earlier phases already exist and will fail without them.

Source documents referenced throughout: [`docs/adr/`](../adr/README.md) (17 ADRs), [`docs/ddd/`](../ddd/README.md) (context map + 8 bounded contexts), [`docs/research/`](../research/README.md).

---

## Phase 0 — Platform Bootstrap

```text
Bootstrap the Agentics Foundation Volunteer Portal repository. This is a gamified,
social volunteer-management platform with a training-video library, built to a
genuine production-grade quality bar (no monetization/billing in scope). Nothing
exists yet — you are building the empty, correctly-shaped container every later
phase will be implemented inside. Do not implement any domain logic (no Person,
no Opportunity, no Course) in this phase.

Read and follow exactly: ADR-0001 (modular monolith, one Postgres schema per
bounded context), ADR-0002 (Next.js App Router), ADR-0003 (tRPC + versioned
REST), ADR-0004 (Postgres + Prisma multi-schema), ADR-0005 (ULID identifiers),
ADR-0015 (testing & CI/CD strategy), ADR-0016 (hosting & infra — dev
environment only; staging/prod come later). All live in docs/adr/. Skim
docs/ddd/00-context-map.md for the full list of 8 bounded contexts you're
pre-wiring folders and schemas for: identity, volunteering, training,
gamification, community, moderation, notifications, admin.

Build:
1. A Next.js 14+ App Router project, TypeScript strict mode, following ADR-0002's
   rendering strategy (React Server Components for data-heavy pages, client
   components only for interactive islands).
2. An `apps/web/src/modules/<context>/` folder per bounded context (all 8, empty
   except a stub `index.ts` each), with a lint rule that fails the build if one
   module imports another module's internals instead of going through its
   `index.ts` — this is the module-boundary rule ADR-0001 depends on for every
   later phase. Prove the rule works with a deliberately-broken test import that
   the lint rule catches.
3. Prisma in multi-schema mode against a single Postgres 15+ instance. Choose a
   concrete managed Postgres provider per ADR-0016 (Neon or Supabase) and wire a
   real dev connection string. Create all 8 schemas via a baseline migration
   (empty schemas — no tables yet).
4. `packages/ulid`, wrapping the `ulid` npm package, as the single place every
   module generates IDs from (ADR-0005).
5. A tRPC root router wired into Next.js with per-module sub-routers registered
   as empty stubs, and a versioned public REST scaffold at `apps/web/app/api/v1/`
   (ADR-0003).
6. A `packages/audit` package with an empty `recordAuditEvent()` export — it gets
   implemented for real in the next phase, but create the package and its shape
   now.
7. Vitest (unit/integration) and Playwright (e2e) configured and passing with
   zero tests. A GitHub Actions CI pipeline that gates merges to `main` on:
   lint, typecheck, unit, e2e-smoke, and a Prisma migration dry-run against a
   shadow database (ADR-0015).
8. A working local dev environment (Docker Compose Postgres or a cloud dev
   branch) and a `.env.example` documenting every required variable.

Do not consider this phase complete until: `pnpm dev` (or your package manager's
equivalent) runs a blank app against a real Postgres instance with all 8 empty
schemas migrated; CI passes green on a trivial PR; the module-boundary lint rule
demonstrably fails on a broken import; and `packages/ulid` and `packages/audit`
are importable from every module stub.
```

---

## Phase 1 — Event Backbone & Platform Audit Log

```text
Already built: Phase 0 (empty Next.js/Prisma/multi-schema monolith, CI, ULIDs,
module-boundary lint rule).

You are building the cross-context integration mechanism every bounded context
in this platform depends on from the moment it starts writing data. Build this
once, generically, before any domain module (Identity, Volunteering, etc.)
exists — do not implement any domain logic in this phase.

Read and follow exactly: ADR-0009 (transactional outbox + graphile-worker) and
ADR-0014 (data privacy & compliance architecture) in docs/adr/ — but from
ADR-0014 you only need the `admin.audit_log` table and the
`recordAuditEvent()`/`audit_log_writer` mechanism it specifies; ignore the
consent/DSAR/retention sections, those belong to later phases. Also read the
"There is one audit log, not two" integration note in
docs/ddd/admin-reporting.md, and the `admin.audit_log` portion of its Schema
Sketch — ignore `ReportDefinition`/`ExportJob` in that same document entirely,
they come much later.

Build:
1. The `admin.audit_log` table exactly as ADR-0014 §4 specifies: append-only at
   the database-role level (REVOKE UPDATE, DELETE for the application's
   Postgres role — corrections are new rows, never edits).
2. graphile-worker installed and configured against the same Postgres instance,
   with an `audit_log_writer` job registered per ADR-0014's Implementation
   Notes.
3. The standard `<schema>.domain_events` table shape every bounded context will
   replicate starting next phase: `id` (ULID), `aggregate_type`, `aggregate_id`,
   `event_type`, `payload` (jsonb), `occurred_at`, `processed_at`, `attempts`.
   Write this as a reusable Prisma schema fragment/template, not a shared table
   — each schema gets its own physical outbox table.
4. The real implementation of `packages/audit`'s
   `recordAuditEvent(tx, { actorId, actorType, action, resourceType, resourceId,
   scopeType?, scopeId?, beforeState?, afterState?, metadata? })`: inside the
   caller's own database transaction, it writes an `'audit.recorded'` event into
   the caller's own schema's `domain_events` table with `audit: true` in the
   payload.
5. A generic outbox-drain helper package (`packages/outbox`) that any future
   consumer can use to poll a `domain_events` table and dispatch to registered
   handlers, including the idempotency pattern every consumer from Phase 5
   onward must use: a `processed_events` ledger table keyed by source event ID,
   so a redelivered event is never double-processed. Document this pattern with
   a worked example in the package's README, since five later phases copy it.

Do not consider this phase complete until: an integration test writes a fake
privileged action via `recordAuditEvent()` in a throwaway schema and confirms
`audit_log_writer` drains it into `admin.audit_log` within the job's poll
interval; a test confirms the app's Postgres role cannot UPDATE or DELETE a row
in `admin.audit_log`; and `packages/outbox`'s idempotency pattern is documented
with a runnable example.
```

---

## Phase 2 — Identity & Access

```text
Already built: Phase 0 (monolith skeleton), Phase 1 (event backbone,
`recordAuditEvent()`, `admin.audit_log`).

You are implementing the Identity & Access bounded context — the upstream
context every other module in this platform depends on for "who is this
person" and "are they allowed to do this." Nothing about roles, chapters, or
consent exists yet outside this phase.

Read and implement exactly what's specified in docs/ddd/identity-access.md and
docs/ddd/identity-access-schema-api.md — every aggregate (Person, Chapter,
RoleAssignment, ConsentRecord, DSARRequest), every field, every invariant,
every domain event, the full schema DDL, and the full tRPC/REST API contract.
Follow these ADRs (in docs/adr/) for the decisions behind that design:
ADR-0005 (ULIDs), ADR-0006 (Supabase Auth), ADR-0007 (scoped RBAC and the
`can()` policy module), ADR-0008 (single-tenant, chapter-scoped model),
ADR-0009 (this context's own `identity.domain_events` outbox, using Phase 1's
pattern), and ADR-0014 in full (consent records, DSAR intake and orchestration,
age gating — this context owns all of it).

Build:
1. The `identity` schema tables per identity-access-schema-api.md's Schema
   Sketch: chapters, persons, role_assignments, consent_records, dsar_requests,
   domain_events.
2. Supabase Auth integration: JWT verification middleware, secure httpOnly
   cookie session handling, and the `RegisterPerson` translation from a
   verified Supabase session into a Person row. Supabase's own user schema and
   claims shape must never leak past this translation boundary — no other code
   in the system should know anything about Supabase's internal user model.
3. The shared `can(subject, action, resource)` policy module (ADR-0007), backed
   by `role_assignments`, exported for every other context to call starting
   next phase.
4. Every Key Use Case documented in identity-access.md: RegisterPerson,
   GrantRole, RevokeRole, RecordConsent, RevokeConsent, RequestDataExport,
   RequestErasure/AnonymizePerson, CreateChapter, AssignChapterLead — each
   emitting its documented domain event and tagging its privileged action via
   Phase 1's `recordAuditEvent()`.
5. The `getPersonSummary(personId)` Open Host Service query — this becomes the
   ONLY way any other module in this codebase may ever read Person data. No
   other module may import `identity`'s Prisma models directly, now or later.
6. The full tRPC router and REST DSAR endpoints exactly as specified in the API
   Contract Sketch.
7. Age-gating enforcement (16+ attestation, or an active guardian_consent
   ConsentRecord below that age) at RegisterPerson.

Do not consider this phase complete until: a user can sign up through Supabase
Auth and a Person row with a terms_of_service ConsentRecord is created; an
org_admin can grant/revoke a scoped role and a chapter_lead is blocked from
granting org_admin (write this as a negative test); a full DSAR export request
round-trips to a signed download URL; a DSAR erasure request anonymizes a
Person's identifying fields while the row itself survives (assert no cascade
delete anywhere); and integration tests (not just unit tests) specifically
cover the consent and DSAR code paths, per ADR-0015.
```

---

## Phase 3 — Volunteering & Opportunities

```text
Already built: Phase 0, Phase 1, Phase 2 (identity.getPersonSummary, can(),
chapters, role assignments all exist and are callable).

You are implementing the Volunteering & Opportunities bounded context — the
platform's core value proposition: posting volunteer opportunities, scheduling
shifts, taking applications, and turning logged time into grant-defensible hour
records.

Read and implement exactly what's specified in
docs/ddd/volunteering-opportunities.md and
docs/ddd/volunteering-opportunities-schema-api.md — the Opportunity, Shift,
Application, and HourEntry aggregates, every field, every invariant, every
state machine, the full schema DDL, and the full API contract. Follow ADR-0007
(authorization on approval actions — call the identity.can() policy module from
Phase 2), ADR-0009 (publish this context's own outbox events; you are the
first bounded context other modules will later consume from), ADR-0014 (hour
entries must be immutable once approved — this is a direct compliance
requirement, not a style preference), and ADR-0017 (add the tsvector generated
column and GIN index on opportunities now, per the Postgres full-text-search
decision, rather than retrofitting it in a later migration).

Build:
1. The `volunteering` schema: opportunities, shifts, applications, hour_entries,
   domain_events, per the Schema Sketch. These four aggregates share one schema
   and use real foreign keys between each other — the no-cross-schema-FK rule
   only applies at bounded-context boundaries, not within one.
2. The Opportunity/Shift/Application/HourEntry state machines exactly as
   documented, including the Shift capacity/acceptedCount concurrency
   invariant (accepted count must never exceed capacity, updated in the same
   transaction as any Application transition) and waitlist promotion when an
   accepted Application is declined or withdrawn.
3. The hour-entry approve/reject workflow: submitted → approved/rejected, with
   approver identity and timestamp recorded, and a hard invariant that no code
   path may mutate a HourEntry once it reaches approved.
4. The `prerequisiteCourseIds` field on Opportunity and its
   `hasCompletedRequiredTraining` check — STUB this to always return true for
   now, since the Training context doesn't exist yet. The next phase will come
   back and replace this stub with a real check; do not block this phase
   waiting for Training.
5. Publication of every documented domain event (including HoursApproved) to
   volunteering.domain_events — later phases will consume these, but you are
   only responsible for reliable publishing here.
6. A `volunteering.queryApprovedHours(filters)` read function for grant
   reporting — build it now even though nothing calls it yet; a much later
   phase (Admin & Reporting) depends on it existing.

Do not consider this phase complete until: a person can apply to a shift, get
accepted or correctly waitlisted at capacity, and waitlist promotion fires
correctly when an accepted application is withdrawn; an hour entry moves
submitted → approved with approver and timestamp recorded, and any attempt to
mutate it afterward fails (write this as a negative test); an integration test
confirms HoursApproved events land reliably in volunteering.domain_events (this
specific path needs integration coverage per ADR-0015); and opportunity search
returns relevant results via the tsvector column.
```

---

## Phase 4 — Training & Learning

```text
Already built: Phase 0-2, Phase 3 (Volunteering exists, with a stubbed
hasCompletedRequiredTraining check you will come back and finish in this
phase).

You are implementing the Training & Learning bounded context: the video-based
training library. Part of this phase's job is also to go back into the
Volunteering module from Phase 3 and finish the prerequisite-gating integration
that was deliberately stubbed there.

Read and implement exactly what's specified in docs/ddd/training-learning.md —
the Course, Module, Video, Enrollment, Quiz, and Certificate aggregates, every
field, every invariant, the full schema DDL, and the full API contract. Follow
ADR-0009 (this context's own outbox), ADR-0010 (Cloudflare Stream, signed
short-lived playback URLs, and the mandatory publish gate on human-corrected
captions — read this ADR's explicit rejection of unlisted-YouTube-style
approaches for a production platform), ADR-0011 (Cloudflare R2 for generated
certificates), ADR-0014 (WCAG 2.1 AA captioning is a compliance requirement,
not an optional nice-to-have), and ADR-0017 (add tsvector search across course
titles, module titles, and video transcript text).

Build:
1. The `training` schema: course, module, video, enrollment, module_progress,
   quiz, quiz_attempt, certificate, domain_events.
2. The Cloudflare Stream ingestion pipeline: upload triggers processing, an
   encode-complete webhook produces a VideoEncodeCompleted event and marks the
   video ready, and playback is only ever served via signed, short-lived URLs
   gated by both enrollment and a can() check.
3. The captioning workflow: an auto-caption draft is generated on upload, a
   caption_status field tracks review state, and PublishCourse must hard-fail
   if any Module's Video has caption_status other than approved — no code path
   may bypass this gate.
4. The module-completion invariant (watch-progress >= 90% AND any attached quiz
   passed before a module counts as complete), resume-where-left-off progress
   tracking, and certificate generation to R2 on course completion.
5. Publication of CourseCompleted, ModuleCompleted, and CertificateIssued
   events — the Gamification phase depends on these.
6. Go back into the Volunteering module (Phase 3) and replace the stubbed
   hasCompletedRequiredTraining check with a real call to this context's
   published query function that checks a person's completed courses against
   an Opportunity's prerequisiteCourseIds. This is required, not optional, work
   in this phase.
7. Add the tsvector generated column and GIN index across course/module titles
   and video transcript text.

Do not consider this phase complete until: a course cannot be published while
any module's video is caption-unapproved (write this as a negative test);
completing all modules and passing required quizzes issues a certificate to R2
and emits CourseCompleted; an Opportunity with prerequisiteCourseIds set now
actually blocks an ineligible applicant and allows an eligible one — this
specific regression test is the proof that the Phase 3 stub was correctly
replaced, not just that Training works in isolation; and training content is
searchable via the tsvector column.
```

---

## Phase 5 — Gamification

```text
Already built: Phase 0-2, Phase 3 (publishes HoursApproved), Phase 4 (publishes
CourseCompleted / ModuleCompleted).

You are implementing the Gamification bounded context: points, badges, and
streaks. This is the first bounded context in the build whose entire job is
consuming other contexts' domain events rather than being a primary source of
truth for user-initiated actions — use the idempotent-consumer pattern from
Phase 1's packages/outbox for real here.

Read and implement exactly what's specified in docs/ddd/gamification.md — the
append-only PointsLedgerEntry, Badge, BadgeAward, Streak, and scoped Leaderboard
projection, every invariant, the full schema DDL, and the full API contract.
Follow ADR-0009 for the outbox-consumption and idempotency mechanics.

Important product constraint from the underlying research, not just a
technical detail: this platform's volunteers are a high-intrinsic-motivation
audience where heavy-handed gamification has been shown to backfire. Leaderboards
must be scoped to a team or challenge and must NEVER be global/platform-wide —
do not build a global-scope leaderboard option even as a configuration toggle.
Points are a supporting mechanic, not the primary reward; badges are the
durable, shareable artifact.

Build:
1. The `gamification` schema: points_ledger_entry (append-only — there is no
   mutable point-total column anywhere; current totals are always computed as a
   projection over the ledger), badge, badge_award, streak, and a materialized
   leaderboard projection, plus domain_events.
2. Event consumers for HoursApproved (from volunteering) and
   CourseCompleted/ModuleCompleted (from training), each idempotent via a
   processed_events table keyed by source event ID.
3. Streak logic with a forgiveness/grace mechanic — track freeze count and last
   activity date, and do not implement a pure punish-on-any-miss streak.
4. Team/challenge-scoped leaderboards only, rebuilt from the points ledger as a
   read-model, never a second source of truth.
5. Publication of PointsAwarded, BadgeAwarded, StreakExtended, and
   StreakBroken events — Community and Notifications consume these in later
   phases.

Do not consider this phase complete until: replaying the same HoursApproved
event twice awards points exactly once (write this as the explicit idempotency
test); no leaderboard API path can return an unscoped, platform-wide ranking —
assert this at the API layer itself, not just by code-review convention; and a
badge, once awarded, remains visible on a person's profile even after the
badge's own definition is later deactivated (test this specifically).
```

---

## Phase 6 — Community & Social

```text
Already built: Phase 0-2 (identity display data available via
getPersonSummary), Phase 5 (publishes BadgeAwarded / PointsAwarded /
StreakExtended). Phase 3 and 4's events are also consumed here.

You are implementing the Community & Social bounded context: the activity feed,
kudos, teams, and mentorship — where events from every other context become
human-visible activity.

Read and implement exactly what's specified in docs/ddd/community-social.md —
the Post, FeedEntry, Kudos, Team, and Mentorship aggregates, every invariant,
the full schema DDL, and the full API contract. Follow ADR-0009 (this context
is a heavy multi-source event consumer), ADR-0011 (Cloudflare R2 for post
attachments), and ADR-0017 (Postgres full-text search on posts).

Build:
1. The `community` schema: post, feed_entry, kudos, team, team_membership,
   mentorship, domain_events.
2. FeedEntry exactly as documented, with a hard behavioral split: native
   kind='post' entries stay a live pointer into community.post so edits/hides
   propagate, while cross-context-sourced kinds (badge_awarded, hours_approved,
   course_completed, streak_extended) are immutable snapshots that never
   change after creation.
3. One event-handler per source event type, translating BadgeAwarded /
   HoursApproved / CourseCompleted / StreakExtended into FeedEntry rows.
4. A `getPostSnapshot(postId)` Open Host Service query. Build and expose this
   now even though nothing calls it yet — the Moderation phase depends on it
   existing before it can be implemented.
5. A chapter-scoped, reverse-chronological feed query using the index shape
   documented in the schema sketch — an org-wide feed and a chapter feed are
   both real, distinct query paths, never mixed.
6. Team creation/joining and the Mentorship request-accept lifecycle.

Do not consider this phase complete until: earning a badge (Phase 5) produces a
feed entry within one outbox-drain cycle, and that entry's content is unchanged
even after the underlying badge definition is later edited (proving it's a
true snapshot, not a live join); a chapter-scoped feed query never returns
another chapter's restricted posts; and getPostSnapshot has its own contract
test asserting a stable return shape, since nothing will exercise it
end-to-end until the next phase exists.
```

---

## Phase 7 — Moderation & Trust & Safety

```text
Already built: Phase 0-2 (moderator role/authority via role_assignments), Phase
6 (community.getPostSnapshot exists, and there is real content to moderate).

You are implementing the Moderation & Trust/Safety bounded context: the report
intake pipeline and the graduated enforcement ladder (warn -> mute -> suspend
-> ban). Part of this phase's job is also to go back into the Community module
from Phase 6 and add the enforcement check that was deliberately left out
there.

Read and implement exactly what's specified in
docs/ddd/moderation-trust-safety.md — the Report and ModerationAction
aggregates, the Report status state machine, the enforcement-ladder scope
rules, every invariant, the full schema DDL, and the full API contract. Follow
ADR-0007 (chapter-scoped vs. org-scoped moderator authority), ADR-0009
(outbox), ADR-0011 (evidence attachments in R2), and ADR-0014.

Critical design constraint, already resolved once and must not be
reintroduced: this context does NOT get its own audit_log table. ADR-0014
explicitly rejects per-schema audit tables — every privileged action here uses
Phase 1's recordAuditEvent() to contribute to the single, shared
admin.audit_log, exactly like every other context. Do not create a
moderation.audit_log table under any circumstance.

Build:
1. The `moderation` schema: report, moderation_action, domain_events. No
   audit_log table in this schema — confirm this explicitly before you
   consider the schema finished.
2. The polymorphic Report aggregate: {reportedEntityType, reportedEntityId}
   plus a reportedContentSnapshot captured once, at file-time, via the owning
   context's own snapshot query (e.g. community.getPostSnapshot from Phase 6)
   — never a live join, never re-synced after filing.
3. The Report status state machine (open -> reviewing -> resolved|dismissed)
   and the enforcement ladder (warn/mute/suspend/ban) with its scope rules: a
   chapter-scoped moderator may only issue chapter-scoped actions within their
   own chapter; a ban is always org-scoped regardless of where the report
   originated.
4. A `getActiveActionsForPerson(personId, scope)` Open Host Service query.
5. Go back into the Community module (Phase 6) and add the enforcement check to
   CreatePost and GiveKudos: before allowing the write, call
   moderation.getActiveActionsForPerson to check for an active suspend/ban in
   the relevant scope, and reject the write if one exists. This is required
   work in this phase, not optional follow-up.
6. Every privileged mutation in this context uses Phase 1's
   recordAuditEvent() — do not build any alternative audit mechanism.
7. A `moderation.queryModerationHistory(filters)` Open Host Service query — the
   Admin & Reporting phase depends on this existing.

Do not consider this phase complete until: filing a report against a Post
captures an immutable content snapshot that does not change even after the
Post is later edited; a chapter-scoped moderator is blocked from issuing an
org-scoped action (negative test), and a ban is always recorded as org-scoped
regardless of report origin; an active suspend or ban actually blocks
CreatePost and GiveKudos in Community — this regression test is the proof the
Phase 6 callback was wired correctly, not just that Moderation works in
isolation; and a migration-level check (or a grep in CI) confirms no
moderation.audit_log table exists anywhere in the schema, while
admin.audit_log receives a summarized entry for every moderation action.
```

---

## Phase 8 — Notifications

```text
Already built: Phase 0-2, Phase 3, Phase 4, Phase 5, Phase 6, Phase 7 — this
phase consumes domain events from all of them, which is why it's sequenced
last among the "feature" bounded contexts.

You are implementing the Notifications bounded context: transactional email and
an in-app notification center, driven entirely by consuming other contexts'
domain events.

Read and implement exactly what's specified in docs/ddd/notifications.md — the
Notification, NotificationPreference, and DeliveryAttempt aggregates, every
invariant, the full schema DDL, and the full API contract. Follow ADR-0009
(one consumer, many event sources), ADR-0012 (Resend for transactional email
plus the in-app center), and ADR-0014 — the consent-gating requirement here is
a legal obligation, not a UX nicety.

Build:
1. The `notifications` schema: notification, notification_preference,
   delivery_attempt, domain_events.
2. One event-handler per source event type, covering the full list: 
   HoursApproved (volunteering), BadgeAwarded / StreakBroken (gamification),
   CourseCompleted / CertificateIssued (training), KudosGiven /
   MentorshipStarted (community), ModerationActionTaken (moderation).
3. The double-gated consent check: a notification must never be queued for a
   type the person has opted out of (checked at queue time), and must never be
   delivered even if it was already queued before the person's preference
   changed (checked again, independently, at delivery time).
4. Resend integration for transactional email, plus an in-app notification
   center with read/unread state, and a digest-vs-real-time delivery setting
   per notification type.

Do not consider this phase complete until: a test proves opting out of a
notification type BEFORE the triggering event fires means it is never queued,
and a separate test proves opting out AFTER it's queued but before delivery
means it is never sent — both timings must be tested explicitly, not just one;
and an end-to-end test fires each of the six upstream event types listed above
and asserts a corresponding notification row is produced for each one.
```

---

## Phase 9 — Admin & Reporting

```text
Already built: Phase 1 (admin.audit_log already exists), Phase 2 (identity's
DSAR machinery is the orchestration target), Phase 3
(volunteering.queryApprovedHours exists), Phase 7
(moderation.queryModerationHistory exists).

You are implementing the rest of the Admin & Reporting bounded context: grant
reporting, DSAR orchestration from the admin console, and cross-cutting audit
search. Note that admin.audit_log itself was already built in Phase 1 — this
phase adds the reporting and query layer on top of it, it does not rebuild it.

Read and implement exactly what's specified in docs/ddd/admin-reporting.md —
the full document now, specifically the ReportDefinition and ExportJob
aggregates (the AuditLogQuery section and the audit_log table itself were
already covered in Phase 1; re-read the "There is one audit log, not two"
integration note as a refresher, not as new work). Follow ADR-0009, ADR-0011
(R2 export files), and ADR-0014 (DSAR orchestration as a command to identity,
never direct data ownership, plus the retention-sweep job).

Build:
1. The `admin` schema additions: report_definition, export_job (audit_log and
   retention_policies already exist from Phase 1).
2. The ReportDefinition/ExportJob lifecycle, including the
   snapshotted-valuation-rate invariant: the hourly valuation rate used in a
   completed grant report is fixed at generation time and must never silently
   change if the underlying ReportDefinition's rate is edited afterward.
3. OrchestrateDsarRequest: calls identity.submitDsarRequest(...) as a command —
   never reads or writes identity's tables directly — and consumes identity's
   DsarExportCompleted / DsarEraseCompleted events to correlate the result back
   to the originating ExportJob.
4. SearchAuditLog, dispatching to admin.audit_log (platform-wide summary)
   and/or moderation.queryModerationHistory (full evidence-linked detail),
   unioned in application code — never a cross-schema SQL join.
5. The retention_sweep graphile-worker job from ADR-0014, which identifies rows
   past their retention window per data class and invokes each owning schema's
   own cleanup function directly.

Do not consider this phase complete until: a grant report generated today, then
re-run after the hourly valuation rate is edited, reproduces its original
dollar figures exactly (this is the snapshot invariant, test it explicitly); a
DSAR erasure triggered from the admin console anonymizes the target Person via
identity's own machinery and the ExportJob correctly reflects completion;
SearchAuditLog with source: 'both' returns both a platform-wide summary entry
and, for a moderation action, the fuller moderation-owned detail, tagged so a
UI could tell them apart; and the retention sweep, run against seeded stale
data, anonymizes/deletes exactly the rows past their retention window and
leaves rows still inside the window untouched (test both sides of that
boundary).
```

---

## Phase 10 — Observability & Production Hardening

```text
Already built: Phase 0 through Phase 9 — every bounded context now exists. This
phase instruments and hardens what they built; it does not add new domain
logic.

You are bringing this platform's operational posture up to a genuine
production bar. Follow ADR-0013 (Sentry, OpenTelemetry, structured logging,
concrete SLOs, alerting) and ADR-0015 (bring test coverage up to the full bar
across every bounded context, not just the specific paths called out in
earlier phases) and ADR-0016 (finish the staging/prod infrastructure topology
that Phase 0 only stood up for dev).

Build:
1. Sentry wired across the Next.js app and every graphile-worker job.
   OpenTelemetry traces and metrics unified by a shared request/trace ID that
   follows a request from the initial HTTP call through to the eventual
   outbox-drain job that services it.
2. /healthz and /readyz endpoints, and dashboards backed by real data for every
   concrete SLO defined in ADR-0013 (API p95 latency, uptime, outbox-drain
   lag, DSAR fulfillment time).
3. The alerting tiers (page/ticket/dashboard) from ADR-0013, sized for a small
   on-call rotation.
4. Full Terraform coverage for dev/staging/prod: Vercel, the managed Postgres
   provider, and Cloudflare (Stream/R2/CDN) — each environment with its own
   database and Cloudflare/Supabase project, no shared resources between
   environments.
5. A documented, actually-rehearsed disaster-recovery drill: restore Postgres
   from a point-in-time backup into a scratch environment and verify data
   integrity against a known-good checksum or row count.
6. Close any test-coverage gaps left across Phases 2-9 — review every phase's
   completion criteria and confirm they still pass together as a whole system,
   not just individually at the time each phase was merged.

Do not consider this phase complete until: a deliberately-thrown error inside a
graphile-worker job appears in Sentry with a trace that links back to the
original HTTP request that triggered the domain event; every SLO in ADR-0013
has a dashboard panel backed by real production-shaped data, not a
placeholder; the disaster-recovery drill has actually been executed at least
once against a non-production environment with restore time and any
data-loss window documented; and `terraform plan` shows zero drift across all
three environments.
```

---

## Phase 11 — Launch Readiness & Compliance Sign-off

```text
Already built: everything — Phase 0 through Phase 10. This is the final gate
before this platform can be considered live-ready. You are not building new
features; you are verifying the system as a WHOLE satisfies every ADR and
every day-one compliance requirement from the original research, not just each
phase individually.

Read all 17 ADRs in docs/adr/, all 8 bounded-context documents plus
docs/ddd/00-context-map.md in docs/ddd/, and docs/research/README.md
(specifically its "Open questions to validate with the Foundation" section)
before starting.

Build/verify:
1. A WCAG 2.1 AA audit across the full UI, with specific attention to the
   highest-risk surfaces identified in the research: video captions and audio
   description, badge/progress-bar indicators that must not rely on color
   alone, live feed status messages, and keyboard-operable moderation/report
   flows.
2. A live, end-to-end GDPR DSAR drill on a real test account: export request ->
   signed download -> erasure request -> verify anonymization actually
   propagated to every bounded context per the PersonAnonymized fan-out from
   Phase 2, while confirming aggregate historical data (approved-hour totals,
   grant reports already generated) survived completely intact.
3. A security review: a dependency audit, a secrets-management check against
   ADR-0016, and an automated CI check (not a one-time manual grep) that fails
   the build if any cross-schema foreign key or any direct cross-module Prisma
   import has crept into the codebase since Phase 0's original module-boundary
   rule was established.
4. A load test against every SLO defined in ADR-0013, including a specific test
   of outbox-drain lag under a burst of concurrent hour-approvals and
   badge-awards — the exact cross-context path Phases 3 and 5 built.
5. A line-by-line walk of docs/ddd/00-context-map.md's integration table,
   confirming every documented event-publish/event-consume relationship
   between bounded contexts actually exists in the running code, with a
   passing integration test backing each row.
6. A go/no-go review confirming the open questions listed in
   docs/research/README.md were actually answered by the Agentics Foundation
   before this platform launches — not just scoped around during
   implementation.

Do not sign off on launch until: the WCAG audit shows zero Level-A/AA
violations on the core flows (training playback, opportunity signup, hour
submission, moderation report); the DSAR drill completes end-to-end with
documented evidence at each step; CI enforces the cross-schema-FK and
cross-module-import checks automatically going forward; the load test meets or
exceeds every SLO under realistic concurrent load; and every row in the
context map's integration table has a corresponding passing integration test.
```
