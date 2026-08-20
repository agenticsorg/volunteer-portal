# Training & Learning

## Purpose & Scope

The `training` bounded context owns the volunteer-facing course catalog, the video library, learner progress, quizzes, and certificates. It is the system of record for "what training content exists, who has watched/passed what, and what proof of completion looks like."

In scope:
- Course and module authoring and sequencing, including prerequisite structure within a course.
- Video lifecycle: upload, encode status, human-corrected captions, transcript storage.
- Enrollment and per-module progress tracking, including resume-where-left-off.
- Quizzes attached to modules, attempts, and pass/fail scoring.
- Certificate issuance on course completion.

Explicitly out of scope (owned elsewhere, referenced by ID only, no cross-schema FK):
- Who a learner is, their chapter/team, and their roles — owned by `identity.person` / `identity.role_assignments`.
- Whether completing a course unlocks a volunteer role or opportunity — that mapping is owned and interpreted by the `volunteering` context, which subscribes to this context's `CourseCompleted` event.
- Whether completing a course or module earns points/badges — owned and interpreted by `gamification`, which subscribes to `CourseCompleted` / `ModuleCompleted`.
- Notification delivery ("you earned a certificate") — owned by `notifications`, triggered off this context's events.
- Actual video transcoding/storage — delegated to Cloudflare Stream; this context stores only metadata, status, and pointers.

## Ubiquitous Language

| Term | Definition |
|---|---|
| Course | The top-level, publishable unit of training content; an ordered collection of Modules with an overall passing/completion definition. |
| Module | A child unit of a Course — typically one video plus an optional quiz — with a position in the course's sequence and optional prerequisite relationships to other modules in the same course. |
| Video | The playable asset attached to a Module: a pointer to a Cloudflare Stream asset plus duration, caption status, and transcript text. |
| Encode Status | The state of Cloudflare Stream's transcoding pipeline for a Video (`uploading` → `processing` → `ready`/`error`). |
| Caption Status | The state of a Video's captions on the path to WCAG 2.1 AA compliance (`pending` → `auto_generated` → `human_review` → `approved`). Only `approved` captions permit publishing. |
| Transcript | Human-reviewed, timestamped text of a Video's spoken content; also indexed for full-text search of the library. |
| Prerequisite | A directed dependency from one Module to another (or one Course to another) that must be satisfied (completed) before the dependent item can be started. |
| Enrollment | The record of a Person taking a Course: an aggregate that owns per-module Progress. |
| Module Progress | An Enrollment's per-Module state: resume position, watch percentage, and completion timestamp. |
| Resume Position | The playback offset (seconds) a learner last reached in a Module's Video, used to resume playback on return. |
| Watch Progress | The furthest percentage of a Video's duration a learner has watched, used to gate module completion (≥ 90%). |
| Quiz | An optional knowledge check attached to a Module, made up of Questions, each with Choices, and a passing-score threshold. |
| Question | A value object: quiz prompt text, ordering, and its Choices. |
| Choice | A value object: one selectable answer to a Question, flagged correct or incorrect. |
| Quiz Attempt | A learner's single scored submission of answers to a Quiz's Questions, tied to their Enrollment. |
| Passing Score | The minimum percentage of correct answers a Quiz Attempt needs to count as a pass; a Quiz invariant. |
| Certificate | A generated, durable record proving a Person completed a Course, with an optional expiry for renewal-tracking. |
| Publish | The action that makes a Course visible/enrollable to learners; gated by caption-approval and structural invariants. |

## Aggregates, Entities & Value Objects

### Course (Aggregate Root)
Owns its Modules and is the unit of publish/versioning.
- `id`, `slug`, `title`, `description`, `status` (`draft` \| `published` \| `archived`), `createdByPersonId` (ID-only ref to `identity.person`), `passingCertificateEnabled`, `publishedAt`, timestamps.
- Child entity **Module** (ordered): `id`, `courseId`, `title`, `sequence` (int, display order), `isRequired` (bool — a course can have optional supplementary modules that don't gate completion), `videoId` (1:1 ref to a **Video** entity), timestamps.
  - Value object **ModulePrerequisite**: `moduleId`, `prerequisiteModuleId` — expresses a dependency DAG within a course, not merely `sequence` order, because some modules (e.g. two independent electives) have no ordering constraint between them while a capstone module may depend on both.
- Entity **Video** (owned by exactly one Module, but modeled as its own entity because it has an independent lifecycle driven by an external system — Cloudflare Stream):
  `id`, `moduleId` (unique), `cloudflareStreamId`, `durationSeconds`, `encodeStatus`, `captionStatus`, `transcriptText` (nullable until human-reviewed), `thumbnailUrl`, timestamps.
- Entity **Quiz** (0 or 1 per Module): `id`, `moduleId` (unique), `passingScorePercent` (1–100), `maxAttempts` (nullable = unlimited), timestamps.
  - Value objects **Question** and **Choice**, persisted as their own rows (see Schema Sketch) because attempts must reference exact question/choice identity for scoring and audit, but they are conceptually part of the Quiz and never addressed outside it.

**Invariants:**
1. A Module cannot be marked `completed` in a learner's Progress until: `watchProgressPercent >= 90` on its Video **and**, if the Module has a Quiz, the learner has at least one passing Quiz Attempt.
2. A Module cannot be started (progress created) until all of its `ModulePrerequisite` modules are `completed` in that learner's Enrollment.
3. A Course cannot transition to `status = 'published'` if any of its Modules' Video has `captionStatus != 'approved'`, or if it has zero Modules.
4. A Quiz's `passingScorePercent` must be between 1 and 100; a Question must have at least one Choice flagged `isCorrect = true`.
5. `Module.sequence` is unique within a `courseId` (display ordering has no ties), but `ModulePrerequisite` — not `sequence` — is the authority for gating.

### Enrollment (Aggregate Root)
Represents one Person's participation in one Course.
- `id`, `personId` (ID-only ref to `identity.person`), `courseId`, `status` (`active` \| `completed` \| `withdrawn`), `enrolledAt`, `completedAt`, timestamps.
- Child entity **ModuleProgress** (one per Module the learner has touched): `id`, `enrollmentId`, `moduleId`, `status` (`not_started` \| `in_progress` \| `completed`), `resumePositionSeconds`, `watchProgressPercent`, `completedAt`.
- Child entity **QuizAttempt** (references a Quiz, scoped to this Enrollment): `id`, `enrollmentId`, `quizId`, `scorePercent`, `passed`, `submittedAt`, plus per-answer child rows recording the Choice selected per Question (for audit and analytics).

**Invariants:**
1. Exactly one **active** Enrollment may exist per `(personId, courseId)` — re-enrollment after `withdrawn` creates a new Enrollment row rather than reusing the old one, preserving history.
2. `ModuleProgress.resumePositionSeconds` can never exceed the Module's Video `durationSeconds`.
3. `Enrollment.status` transitions to `completed` only when every `isRequired = true` Module has `ModuleProgress.status = 'completed'`; this transition is what triggers `CourseCompleted`.
4. A `QuizAttempt` counts toward `passed` module gating only if `scorePercent >= Quiz.passingScorePercent`; failed attempts are retained for history, not deleted, and count against `maxAttempts` if set.

### Certificate (Aggregate Root — small, standalone)
- `id`, `personId`, `courseId`, `enrollmentId`, `certificateNumber` (human-readable, e.g. `AGF-2026-000482`), `issuedAt`, `expiresAt` (nullable — set only for courses whose content requires periodic renewal, e.g. safety training), `pdfFileKey` (object storage pointer), `templateVersion`.

**Invariants:**
1. Exactly one Certificate per `(personId, courseId)` per issuance cycle — enforced by a unique constraint on `(person_id, course_id, enrollment_id)`; re-issuance after expiry creates a new Certificate row tied to a new Enrollment, never mutates the old one.
2. A Certificate is only ever created as a direct, same-transaction side effect of an Enrollment reaching `status = 'completed'` with `Course.passingCertificateEnabled = true` — never issued directly by a user-facing action.

## Domain Events

All events are written to `training.domain_events` in the same transaction as the state change that produced them (transactional outbox), then drained by `graphile-worker` for delivery to subscribing modules.

| Event | Payload (key fields) | Emitted When | Notable Consumers |
|---|---|---|---|
| `VideoUploaded` | `videoId`, `moduleId`, `cloudflareStreamId` | An admin/instructor initiates upload and Cloudflare Stream accepts the asset. | (internal — drives status UI) |
| `VideoEncodeCompleted` | `videoId`, `durationSeconds`, `encodeStatus` | Cloudflare Stream webhook reports `ready` (translated internally — see Integration Notes). | (internal — unblocks caption workflow) |
| `VideoCaptionsApproved` | `videoId`, `moduleId`, `approvedByPersonId` | A human reviewer approves auto-generated or uploaded captions/transcript. | (internal — unblocks `PublishCourse`) |
| `CoursePublished` | `courseId`, `publishedAt` | `Course.status` transitions to `published`. | `volunteering` (surfaces newly available prerequisite paths), Notifications |
| `EnrollmentStarted` | `enrollmentId`, `personId`, `courseId` | A learner enrolls in a Course. | Gamification (optional streak seed), Notifications |
| `ModuleCompleted` | `enrollmentId`, `personId`, `courseId`, `moduleId` | A `ModuleProgress` transitions to `completed`. | **Gamification** (points/streak/badge eval) |
| `CourseCompleted` | `enrollmentId`, `personId`, `courseId`, `completedAt` | `Enrollment.status` transitions to `completed`. | **Gamification** (badge award), **Volunteering** (role/opportunity unlock) |
| `QuizAttemptFailed` | `enrollmentId`, `quizId`, `scorePercent` | A Quiz Attempt scores below `passingScorePercent`. | Notifications (optional coaching nudge) |
| `CertificateIssued` | `certificateId`, `personId`, `courseId`, `certificateNumber` | A Certificate is created. | Notifications, Community (profile/portfolio display) |

## Key Use Cases / Application Services

1. **CreateCourse** — instructor/admin creates a `draft` Course with metadata; no Modules required at creation.
2. **AddModule** — attaches a Module (and its Video placeholder + optional Quiz) to a Course, sets `sequence`, and optionally declares `ModulePrerequisite` edges to other Modules in the same Course; rejects cycles in the prerequisite graph.
3. **IngestVideoWebhook** — Cloudflare Stream callback handler; validates the webhook signature, updates `Video.encodeStatus`/`durationSeconds`, and emits `VideoEncodeCompleted`.
4. **ApproveCaptions** — a human reviewer submits corrected captions/transcript for a Video; sets `captionStatus = 'approved'`, stores `transcriptText`, emits `VideoCaptionsApproved`.
5. **PublishCourse** — validates the publish invariants (all Videos' captions approved, ≥1 Module), sets `status = 'published'`, `publishedAt`, emits `CoursePublished`.
6. **EnrollInCourse** — creates an `Enrollment` for `(personId, courseId)` if none is currently `active`; seeds `ModuleProgress` rows as `not_started`; emits `EnrollmentStarted`.
7. **RecordProgress** — idempotent resume-position/watch-percentage update from the video player (called frequently, e.g. every 10–15s of playback); when `watchProgressPercent` crosses 90% (and any Quiz is already passed, or the Module has no Quiz), transitions `ModuleProgress` to `completed`, checks whether the Enrollment as a whole is now complete, and emits `ModuleCompleted` / `CourseCompleted` accordingly.
8. **SubmitQuizAttempt** — scores a learner's submitted answers against `Quiz`/`Question`/`Choice`, persists the `QuizAttempt` (and answer rows), enforces `maxAttempts`, emits `QuizAttemptFailed` on failure or triggers the module-completion check (step 7) on a pass.
9. **IssueCertificate** — invoked as a same-transaction side effect of `Enrollment.status → completed` when `Course.passingCertificateEnabled`; allocates `certificateNumber`, renders the PDF (async, via a queued job), emits `CertificateIssued`.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS training;

CREATE TYPE training.course_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE training.encode_status AS ENUM ('uploading', 'processing', 'ready', 'error');
CREATE TYPE training.caption_status AS ENUM ('pending', 'auto_generated', 'human_review', 'approved');
CREATE TYPE training.enrollment_status AS ENUM ('active', 'completed', 'withdrawn');
CREATE TYPE training.progress_status AS ENUM ('not_started', 'in_progress', 'completed');

CREATE TABLE training.course (
  id                          TEXT PRIMARY KEY,                 -- ULID
  slug                        TEXT NOT NULL UNIQUE,
  title                       TEXT NOT NULL,
  description                 TEXT NOT NULL DEFAULT '',
  status                      training.course_status NOT NULL DEFAULT 'draft',
  passing_certificate_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_person_id        TEXT NOT NULL,                    -- identity.person.id, no FK
  published_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_course_status ON training.course (status);

CREATE TABLE training.module (
  id           TEXT PRIMARY KEY,
  course_id    TEXT NOT NULL REFERENCES training.course (id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  is_required  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, sequence)
);
CREATE INDEX idx_module_course ON training.module (course_id);

CREATE TABLE training.module_prerequisite (
  module_id               TEXT NOT NULL REFERENCES training.module (id) ON DELETE CASCADE,
  prerequisite_module_id  TEXT NOT NULL REFERENCES training.module (id) ON DELETE CASCADE,
  PRIMARY KEY (module_id, prerequisite_module_id),
  CHECK (module_id <> prerequisite_module_id)
);

CREATE TABLE training.video (
  id                  TEXT PRIMARY KEY,
  module_id           TEXT NOT NULL UNIQUE REFERENCES training.module (id) ON DELETE CASCADE,
  cloudflare_stream_id TEXT NOT NULL UNIQUE,
  duration_seconds    INTEGER,
  encode_status       training.encode_status NOT NULL DEFAULT 'uploading',
  caption_status      training.caption_status NOT NULL DEFAULT 'pending',
  transcript_text     TEXT,
  thumbnail_url       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Full-text search over transcripts for library discoverability
CREATE INDEX idx_video_transcript_fts ON training.video USING GIN (to_tsvector('english', coalesce(transcript_text, '')));

CREATE TABLE training.quiz (
  id                    TEXT PRIMARY KEY,
  module_id             TEXT NOT NULL UNIQUE REFERENCES training.module (id) ON DELETE CASCADE,
  passing_score_percent SMALLINT NOT NULL CHECK (passing_score_percent BETWEEN 1 AND 100),
  max_attempts          SMALLINT,                                -- NULL = unlimited
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE training.quiz_question (
  id         TEXT PRIMARY KEY,
  quiz_id    TEXT NOT NULL REFERENCES training.quiz (id) ON DELETE CASCADE,
  prompt     TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  UNIQUE (quiz_id, sequence)
);

CREATE TABLE training.quiz_choice (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL REFERENCES training.quiz_question (id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  is_correct   BOOLEAN NOT NULL DEFAULT FALSE,
  sequence     INTEGER NOT NULL,
  UNIQUE (question_id, sequence)
);

CREATE TABLE training.enrollment (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL,                                    -- identity.person.id, no FK
  course_id    TEXT NOT NULL REFERENCES training.course (id) ON DELETE RESTRICT,
  status       training.enrollment_status NOT NULL DEFAULT 'active',
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only one ACTIVE enrollment per person+course
CREATE UNIQUE INDEX uq_enrollment_active_person_course
  ON training.enrollment (person_id, course_id)
  WHERE status = 'active';
CREATE INDEX idx_enrollment_person ON training.enrollment (person_id);

CREATE TABLE training.module_progress (
  id                     TEXT PRIMARY KEY,
  enrollment_id          TEXT NOT NULL REFERENCES training.enrollment (id) ON DELETE CASCADE,
  module_id              TEXT NOT NULL REFERENCES training.module (id) ON DELETE RESTRICT,
  status                 training.progress_status NOT NULL DEFAULT 'not_started',
  resume_position_seconds INTEGER NOT NULL DEFAULT 0,
  watch_progress_percent  SMALLINT NOT NULL DEFAULT 0 CHECK (watch_progress_percent BETWEEN 0 AND 100),
  completed_at           TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, module_id)
);
CREATE INDEX idx_module_progress_enrollment ON training.module_progress (enrollment_id);

CREATE TABLE training.quiz_attempt (
  id            TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES training.enrollment (id) ON DELETE CASCADE,
  quiz_id       TEXT NOT NULL REFERENCES training.quiz (id) ON DELETE RESTRICT,
  score_percent SMALLINT NOT NULL CHECK (score_percent BETWEEN 0 AND 100),
  passed        BOOLEAN NOT NULL,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quiz_attempt_enrollment_quiz ON training.quiz_attempt (enrollment_id, quiz_id);

CREATE TABLE training.quiz_attempt_answer (
  attempt_id   TEXT NOT NULL REFERENCES training.quiz_attempt (id) ON DELETE CASCADE,
  question_id  TEXT NOT NULL REFERENCES training.quiz_question (id) ON DELETE RESTRICT,
  choice_id    TEXT NOT NULL REFERENCES training.quiz_choice (id) ON DELETE RESTRICT,
  is_correct   BOOLEAN NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE training.certificate (
  id                 TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL,                              -- identity.person.id, no FK
  course_id          TEXT NOT NULL REFERENCES training.course (id) ON DELETE RESTRICT,
  enrollment_id      TEXT NOT NULL REFERENCES training.enrollment (id) ON DELETE RESTRICT,
  certificate_number TEXT NOT NULL UNIQUE,
  pdf_file_key       TEXT,
  template_version   TEXT NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  UNIQUE (person_id, course_id, enrollment_id)
);
CREATE INDEX idx_certificate_person ON training.certificate (person_id);

-- Transactional outbox
CREATE TABLE training.domain_events (
  id            TEXT PRIMARY KEY,                                -- ULID, sortable
  event_type    TEXT NOT NULL,                                   -- e.g. 'CourseCompleted'
  aggregate_type TEXT NOT NULL,                                  -- e.g. 'Enrollment'
  aggregate_id  TEXT NOT NULL,
  payload       JSONB NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX idx_domain_events_unprocessed ON training.domain_events (id) WHERE processed_at IS NULL;
```

## API Contract Sketch

Internal, module-to-frontend traffic is tRPC; the public `/api/v1/*` REST surface (e.g. `GET /api/v1/courses`, `GET /api/v1/certificates/:id/verify`) is a thin read-oriented wrapper over the same application services and is omitted here for brevity.

```typescript
// src/modules/training/api/trpc/router.ts
export const trainingRouter = router({
  // Authoring
  createCourse: protectedProcedure
    .input(z.object({ slug: z.string(), title: z.string(), description: z.string().optional() }))
    .mutation(...), // -> { courseId: string }

  addModule: protectedProcedure
    .input(z.object({
      courseId: ulidSchema,
      title: z.string(),
      sequence: z.number().int().positive(),
      isRequired: z.boolean().default(true),
      prerequisiteModuleIds: z.array(ulidSchema).default([]),
    }))
    .mutation(...), // -> { moduleId: string }

  approveCaptions: protectedProcedure
    .input(z.object({ videoId: ulidSchema, transcriptText: z.string().min(1) }))
    .mutation(...), // -> { captionStatus: 'approved' }

  publishCourse: protectedProcedure
    .input(z.object({ courseId: ulidSchema }))
    .mutation(...), // -> { status: 'published', publishedAt: string } | throws INVARIANT_VIOLATION

  // Learner-facing
  enrollInCourse: protectedProcedure
    .input(z.object({ courseId: ulidSchema }))
    .mutation(...), // -> { enrollmentId: string }

  recordProgress: protectedProcedure
    .input(z.object({
      enrollmentId: ulidSchema,
      moduleId: ulidSchema,
      resumePositionSeconds: z.number().int().nonnegative(),
      watchProgressPercent: z.number().int().min(0).max(100),
    }))
    .mutation(...), // -> { moduleStatus: ProgressStatus, courseCompleted: boolean }

  submitQuizAttempt: protectedProcedure
    .input(z.object({
      enrollmentId: ulidSchema,
      quizId: ulidSchema,
      answers: z.array(z.object({ questionId: ulidSchema, choiceId: ulidSchema })),
    }))
    .mutation(...), // -> { scorePercent: number, passed: boolean }

  getMyEnrollment: protectedProcedure
    .input(z.object({ courseId: ulidSchema }))
    .query(...), // -> EnrollmentWithProgressDTO | null

  getCourseCatalog: publicProcedure
    .input(z.object({ status: z.literal('published').default('published') }))
    .query(...), // -> CourseSummaryDTO[]

  getCertificate: protectedProcedure
    .input(z.object({ certificateId: ulidSchema }))
    .query(...), // -> CertificateDTO
});

// Webhook (REST, not tRPC — Cloudflare cannot call tRPC's batched transport)
// POST /api/v1/webhooks/cloudflare-stream  (signature-verified, see Integration Notes)
```

## Integration & Anti-Corruption Notes

**Inbound: Cloudflare Stream webhooks.** Cloudflare Stream calls a plain REST endpoint (`POST /api/v1/webhooks/cloudflare-stream`), not tRPC. The handler is a translation layer (anti-corruption layer) with three jobs: (1) verify the webhook signature against Cloudflare's shared secret; (2) map Cloudflare's payload shape (`uid`, `status.state`, `duration`, `readyToStream`) onto this context's own `Video.encodeStatus` vocabulary — Cloudflare's vocabulary never leaks past this handler into the domain model or into events other modules see; (3) persist the state change and, in the same transaction, insert the `VideoEncodeCompleted` outbox row. Caption ingestion follows a separate path: Cloudflare can auto-generate captions, but this context treats that as only `captionStatus = 'auto_generated'` — a human must review and submit via `ApproveCaptions` before `captionStatus = 'approved'`, which is the only state that satisfies the publish invariant (WCAG 2.1 AA requires accuracy auto-captions don't reliably meet).

**Outbound: what Gamification and Volunteering consume.** This context never calls into `gamification` or `volunteering` directly — it only writes to its own `training.domain_events` outbox. `graphile-worker` drains that table and dispatches to each subscribing module's registered handler. `gamification` subscribes to `ModuleCompleted` and `CourseCompleted` to run badge-award and points-ledger logic; `volunteering` subscribes to `CourseCompleted` to evaluate whether a person now satisfies the prerequisite training for a gated role/opportunity (the *mapping* of "which course unlocks which role" is owned entirely by `volunteering` — this context exposes no opinion on roles, only the fact that a course was completed, keeping the two contexts decoupled). Event payloads are treated as a versioned public contract of this module: `personId`, `courseId`, `moduleId`, and `enrollmentId` are always plain ULID strings, never internal row objects, so downstream consumers cannot become coupled to this schema's internal shape.

**Idempotent delivery.** Because `graphile-worker` guarantees at-least-once delivery, every event this context emits carries its own stable `domain_events.id` (a ULID) as the idempotency key; consumers (per their own bounded-context conventions — see `gamification.md`'s `processed_events` pattern) are expected to de-duplicate on that ID rather than assuming exactly-once delivery.
