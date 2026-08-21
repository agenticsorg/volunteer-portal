# Community & Social

## Purpose & Scope

The `community` bounded context owns peer-to-peer social features: the activity feed, kudos/shoutouts, Team (guild) structures, and mentor/mentee pairing. It is the system of record for "what did a volunteer post, who recognized whom, which teams and mentorships exist" — and it is the *aggregation point* that turns facts owned by other contexts (a badge earned, hours approved, a course completed) into a human-readable, scoped activity feed, without ever becoming the source of truth for those facts.

In scope:
- Posts: short-form updates authored by a Person, scoped to a Chapter or the whole org.
- The activity feed: a denormalized, reverse-chronological, scope-bound read model combining native Posts with projected facts from other contexts.
- Kudos: lightweight peer recognition, optionally tied to a specific achievement.
- Teams (guilds): named, chapter-scoped groups with lead/member roles, for accountability (research 02 §1, Habitica model).
- Mentorship: structured mentor/mentee pairing with an explicit lifecycle.

Explicitly out of scope (owned elsewhere, referenced by ID only, no cross-schema FK):
- Who a Person is, their Chapter, and their roles — owned by `identity.person` / `identity.role_assignments`; this context resolves display data (`displayName`, `avatarUrl`, `publicSlug`) via identity's `getPersonSummary(personId)` Open Host Service query (00-context-map.md §3 row 7), never by joining `identity` tables.
- The *fact* that a badge was awarded, hours were approved, a course was completed, or a streak was extended — owned by `gamification`, `volunteering`, and `training` respectively. This context only consumes their published events to build a read-model projection (`FeedEntry`); it never recomputes or second-guesses those facts.
- Report intake, block/mute/suspend enforcement, and the audit log — owned by `moderation`. This context only reacts to `ModerationActionTaken` by hiding/restricting content it owns; it never decides whether content should be hidden.
- Points/badges/leaderboards themselves — owned by `gamification`. A `KudosGiven` event may optionally feed a small point award, but that interpretation lives in `gamification`, not here.
- Notification delivery — owned by `notifications`, triggered off this context's events (e.g. `KudosGiven` → "you got a kudos" push).

## Ubiquitous Language

| Term | Definition |
|---|---|
| Post | A short-form update authored by a Person, scoped to a Chapter or the whole org, optionally carrying attachments. The only Community-native content type that appears in the feed. |
| Attachment | A value object on a Post: a pointer to an object in Cloudflare R2 (`r2ObjectKey`), plus content type, size, and optional alt text — never binary data stored in Postgres. |
| Scope (post/team/feed) | The visibility breadth of a Post, Team, or feed query: `chapter` (bound to one Chapter) or `org` (visible platform-wide). Never a third "public" tier — the portal has no anonymous social surface. |
| Feed | The reverse-chronological, scope-bound view assembled from `FeedEntry` rows; queried per Chapter or org-wide, never globally merged across scopes in one query. |
| Feed Entry | One row in the feed read model. Either a **native** entry (mirrors a Post 1:1, resolved live from `community.post` at read time) or a **projected** entry (an immutable snapshot built from a consumed external event — a badge award, approved hours, a completed course, an extended streak). |
| Kudos | A lightweight peer-to-peer recognition: one Person thanking another, with an optional note and an optional link to a specific achievement (badge award, hour entry, course completion) the kudos is celebrating. |
| Achievement Reference | The optional `{type, id}` pair on a Kudos pointing at the external achievement being celebrated — stored by type+ID only, never joined. |
| Team | A named, chapter-scoped guild that volunteers join for social accountability (research 02 §1). Owns a member list with per-member roles. |
| Team Membership | A child entity of Team recording one Person's role (`lead` or `member`) and join/leave history within that Team. |
| Mentorship | A structured pairing between a mentor and a mentee, moving through an explicit request → active → completed lifecycle. |
| Processed Event | A row in `community.processed_events` recording that this context has already translated a given external domain event into a `FeedEntry`, guarding against duplicate projection under `graphile-worker`'s at-least-once delivery. |

## Aggregates, Entities & Value Objects

### Post (Aggregate Root)
- `id`, `authorId` (ID-only ref to `identity.person`), `authorDisplayName` (snapshot at creation, refreshed to `'Deleted User'` on `PersonAnonymized` — mirrors ADR-0014 §2's erasure treatment of `community.posts`), `authorChapterId` (ID-only ref to `identity.chapter`, snapshotted at creation — the chapter the author belonged to *when they posted*, used to evaluate the scope invariant below without a live cross-schema read on every write), `body` (plain text/limited markdown, 1–5000 chars), `scopeType` (`chapter` \| `org`), `scopeId` (Chapter ID when `scopeType = 'chapter'`, `NULL` when `org`), child value objects **Attachment** (0–4 per Post), `status` (`published` \| `hidden` \| `deleted`), `hiddenByModerationActionId` (ID-only ref to `moderation.moderation_action`, set only when `status = 'hidden'`), timestamps.

**Invariants:**
1. **A Post's visibility scope cannot exceed its author's chapter membership unless the author has the `org_admin` role.** Concretely: `CreatePost` with `scopeType = 'org'` is rejected at the application layer unless a synchronous `identity` policy check (`can(authorId, "post:org_scope", {})`) succeeds; `scopeType = 'chapter'` requires `scopeId = authorChapterId` (a member cannot post *into* a chapter they don't belong to, even one they can see).
2. A Post's `body` cannot be edited once `status` leaves `published` for the first time (i.e., once hidden or deleted, it is frozen — corrections require a new Post).
3. Only `moderation` (via `ModerationActionTaken`) or the author themselves (self-delete) may transition `status` away from `published`; no other context or role may mutate it directly.

### FeedEntry (Read-Model Projection — not an aggregate root, not a separate source of truth)
- `id`, `kind` (`post` \| `kudos_given` \| `team_joined` \| `mentorship_started` \| `mentorship_completed` \| `badge_awarded` \| `hours_approved` \| `course_completed` \| `streak_extended`), `scopeType`, `scopeId`, `subjectPersonId` (the Person the entry is *about* — the poster, the kudos recipient, the badge earner, etc.), `subjectDisplayName` (snapshot, refreshed on `PersonAnonymized`), `sourceType` (`community.post` \| `community.kudos` \| `community.team_membership` \| `community.mentorship` \| `gamification.badge_award` \| `volunteering.hour_entry` \| `training.course_completion` \| `gamification.streak`), `sourceId` (the originating record's ID in its owning schema), `sourceEventId` (nullable — the `domain_events.id` of the consumed external event, `NULL` for natively-generated entries; drives idempotency), `summary` (pre-rendered display string, e.g. *"Jane earned the Mentor badge"*), `payload` (JSONB — structured data for rich rendering: badge icon key, hours count, course title, streak length), `hiddenAt`, `hiddenByModerationActionId`, `createdAt`.

**Invariants:**
1. **A FeedEntry generated from a cross-context event (`kind` in `badge_awarded`, `hours_approved`, `course_completed`, `streak_extended`) is immutable and cannot be edited, only hidden by moderation.** There is no source-of-truth row in this schema to re-sync from if the external fact were somehow wrong — correcting it is the owning context's problem (e.g. `gamification` revoking a mis-awarded badge would emit its own correcting event, not ask `community` to edit history).
2. A `kind = 'post'` FeedEntry is a thin pointer (`sourceId = post.id`); its `summary`/`payload` are *not* duplicated from the Post at write time — feed queries join `community.post` live (same schema, in-schema join permitted) so a Post edit or hide is reflected without re-projecting. This is the one `kind` where "immutable" (invariant 1) does not apply, because it is not itself a snapshot of an external fact.
3. Exactly one FeedEntry exists per `(sourceType, sourceId)` for native kinds, and per `sourceEventId` for projected kinds — enforced by unique constraints, making re-processing an at-least-once-delivered event a no-op rather than a duplicate feed row.

### Kudos (Entity, not independently aggregated beyond itself)
- `id`, `fromPersonId`, `toPersonId` (both ID-only refs to `identity.person`), `note` (optional, ≤280 chars), `achievementRefType` / `achievementRefId` (optional polymorphic pointer — e.g. `gamification.badge_award` / a badge-award ID, or `volunteering.hour_entry` / an hour-entry ID), `createdAt`.

**Invariants:**
1. `fromPersonId <> toPersonId` — no self-kudos.
2. If `achievementRefType` is set, `achievementRefId` must also be set (and vice versa) — the reference is all-or-nothing.

### Team (Aggregate Root)
- `id`, `chapterId` (ID-only ref to `identity.chapter` — Teams are always chapter-scoped, never org-wide, per the task's guild model), `name`, `description`, `createdByPersonId`, `status` (`active` \| `archived`), timestamps.
- Child entity **TeamMembership**: `id`, `teamId`, `personId` (ID-only ref), `role` (`lead` \| `member`), `joinedAt`, `leftAt` (nullable — a membership row is never deleted, only closed, to preserve history).

**Invariants:**
1. `(chapterId, name)` is unique among `active` Teams — no two active Teams in the same Chapter share a name.
2. A Person has at most one *open* membership (`leftAt IS NULL`) per Team — re-joining after leaving creates a new `TeamMembership` row.
3. A Team must retain at least one `lead` membership open at all times once it has ever had one; the last `lead` cannot leave or be demoted without promoting another member first (enforced at the application layer in `LeaveTeam`/`JoinTeam`, not by a DB constraint, since it requires counting sibling rows).

### Mentorship (Aggregate Root)
- `id`, `mentorPersonId`, `menteePersonId` (both ID-only refs), `status` (`requested` \| `active` \| `completed` \| `declined` \| `cancelled`), `requestedAt`, `startedAt` (nullable), `endedAt` (nullable), `note` (optional, set at request time).

**Invariants:**
1. `mentorPersonId <> menteePersonId`.
2. A Person may have at most one `requested` or `active` Mentorship as **mentee** at a time (enforced by a partial unique index) — a mentee cannot have two open pairings simultaneously; a mentor may have several concurrent mentees, so no equivalent constraint applies to `mentorPersonId`.
3. Legal transitions: `requested → active` (mentor accepts), `requested → declined` (mentor declines), `requested → cancelled` (mentee withdraws before acceptance), `active → completed`, `active → cancelled`. `declined`, `cancelled`, and `completed` are terminal — a new pairing needs a new `Mentorship` row.

## Domain Events

All events are written to `community.domain_events` in the same transaction as the state change that produced them (transactional outbox), then drained by `graphile-worker` for delivery to subscribing modules.

| Event | Payload (key fields) | Emitted When | Notable Consumers |
|---|---|---|---|
| `PostCreated` | `postId`, `authorId`, `scopeType`, `scopeId` | A Post is successfully created. | (internal — drives `FeedEntry` visibility; no external subscriber v1) |
| `PostHidden` | `postId`, `moderationActionId` | `moderation` hides a Post via `ModerationActionTaken`. | Notifications (inform the author) |
| `KudosGiven` | `kudosId`, `fromPersonId`, `toPersonId`, `achievementRefType?`, `achievementRefId?` | A Kudos is created. | **Gamification** (optional small point award — 00-context-map.md §3 row 22), Notifications (notify recipient) |
| `TeamCreated` | `teamId`, `chapterId`, `createdByPersonId` | A Team is created. | Notifications |
| `TeamJoined` | `teamId`, `personId`, `role` | A `TeamMembership` opens. | Notifications, Gamification (optional "joined a team" milestone) |
| `TeamLeft` | `teamId`, `personId` | A `TeamMembership` closes. | (internal) |
| `MentorshipRequested` | `mentorshipId`, `mentorPersonId`, `menteePersonId` | A mentee (or admin match) requests a pairing. | Notifications (notify prospective mentor) |
| `MentorshipStarted` | `mentorshipId`, `mentorPersonId`, `menteePersonId` | The mentor accepts a request. | Notifications, Gamification (optional onboarding-quest tie-in, research 02 §4) |
| `MentorshipCompleted` | `mentorshipId`, `mentorPersonId`, `menteePersonId` | Either party marks the pairing complete. | Notifications, Gamification |

### Consumed External Events (build `FeedEntry` projections only — never mutate this context's own aggregates)

| Event | Source Context | Projected `FeedEntry.kind` |
|---|---|---|
| `BadgeAwarded` | Gamification | `badge_awarded` |
| `HoursApproved` | Volunteering | `hours_approved` |
| `CourseCompleted` | Training | `course_completed` |
| `StreakExtended` | Gamification | `streak_extended` (projected selectively — see Integration Notes on milestone filtering) |
| `PersonAnonymized` | Identity | *(not a FeedEntry — updates `authorDisplayName`/`subjectDisplayName` snapshots to `'Deleted User'` across this schema)* |

## Key Use Cases / Application Services

1. **CreatePost** — validates body length and the scope invariant (chapter membership vs. `org_admin`), snapshots `authorDisplayName`/`authorChapterId`, persists the Post, emits `PostCreated`.
2. **GiveKudos** — validates `fromPersonId <> toPersonId` and the achievement-reference all-or-nothing rule, persists the Kudos, creates a native `FeedEntry` (`kind = 'kudos_given'`), emits `KudosGiven`.
3. **CreateTeam** — validates `(chapterId, name)` uniqueness among active Teams, creates the Team with the creator as an initial `lead` membership, emits `TeamCreated`.
4. **JoinTeam** — validates no existing open membership for `(teamId, personId)`, opens a `TeamMembership` with `role = 'member'`, creates a native `FeedEntry` (`kind = 'team_joined'`), emits `TeamJoined`.
5. **RequestMentorship** — validates the mentee has no other open (`requested`/`active`) Mentorship, creates the pairing in `requested` status, emits `MentorshipRequested`.
6. **AcceptMentorship** — transitions `requested → active`, sets `startedAt`, creates a native `FeedEntry` (`kind = 'mentorship_started'`), emits `MentorshipStarted`.
7. **RebuildFeedProjection** — an operational/admin use case (not user-facing): given a scope and/or source type, truncates and re-derives affected `FeedEntry` rows from `community.post` (for native entries) and by replaying the relevant external contexts' outbox history from `community.processed_events`'s watermark (for projected entries). Used to recover from a projection bug or a schema change to `payload`/`summary` rendering, without needing the upstream contexts to re-emit events.

**Supporting handlers (system-triggered, not user-initiated use cases):**
- `HandleBadgeAwarded` / `HandleHoursApproved` / `HandleCourseCompleted` / `HandleStreakExtended` — one `graphile-worker` job handler per consumed external event type; see Integration & Anti-Corruption Notes.
- `HandleModerationActionTaken` — consumes `moderation.ModerationActionTaken`; when the action targets a `community.post` or a `community.team` resource, flips `Post.status = 'hidden'` (or hides the relevant `FeedEntry`) in the same transaction as recording `hiddenByModerationActionId`.
- `HandlePersonAnonymized` — consumes `identity.PersonAnonymized`; bulk-updates `authorDisplayName`/`subjectDisplayName` snapshots for the anonymized Person to `'Deleted User'` across `post` and `feed_entry`.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS community;

CREATE TYPE community.scope_type AS ENUM ('org', 'chapter');
CREATE TYPE community.post_status AS ENUM ('published', 'hidden', 'deleted');
CREATE TYPE community.feed_entry_kind AS ENUM (
  'post', 'kudos_given', 'team_joined', 'mentorship_started', 'mentorship_completed',
  'badge_awarded', 'hours_approved', 'course_completed', 'streak_extended'
);
CREATE TYPE community.team_status AS ENUM ('active', 'archived');
CREATE TYPE community.team_role AS ENUM ('lead', 'member');
CREATE TYPE community.mentorship_status AS ENUM ('requested', 'active', 'completed', 'declined', 'cancelled');

CREATE TABLE community.post (
  id                          TEXT PRIMARY KEY,                          -- ULID
  author_id                   TEXT NOT NULL,                             -- identity.person.id, no FK
  author_display_name         TEXT NOT NULL,                             -- snapshot; 'Deleted User' after PersonAnonymized
  author_chapter_id           TEXT,                                      -- identity.chapter.id, no FK; snapshot at creation
  body                        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  scope_type                  community.scope_type NOT NULL,
  scope_id                    TEXT,                                      -- identity.chapter.id, no FK; NULL iff scope_type = 'org'
  attachments                 JSONB NOT NULL DEFAULT '[]',               -- [{r2ObjectKey, contentType, sizeBytes, altText}]
  status                      community.post_status NOT NULL DEFAULT 'published',
  hidden_by_moderation_action_id TEXT,                                   -- moderation.moderation_action.id, no FK
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'org') = (scope_id IS NULL)),
  CHECK (jsonb_array_length(attachments) <= 4)
);
CREATE INDEX idx_post_scope_created ON community.post (scope_type, scope_id, id DESC);
CREATE INDEX idx_post_author ON community.post (author_id);

-- Denormalized feed read model — reverse-chronological, scope-bound queries are the hot path.
CREATE TABLE community.feed_entry (
  id                          TEXT PRIMARY KEY,                          -- ULID (sorts chronologically, ADR-0005)
  kind                        community.feed_entry_kind NOT NULL,
  scope_type                  community.scope_type NOT NULL,
  scope_id                    TEXT,
  subject_person_id           TEXT NOT NULL,                             -- identity.person.id, no FK
  subject_display_name        TEXT NOT NULL,
  source_type                 TEXT NOT NULL,                             -- 'community.post' | 'gamification.badge_award' | ...
  source_id                   TEXT NOT NULL,
  source_event_id             TEXT,                                      -- origin domain_events.id; NULL for native kinds
  summary                     TEXT NOT NULL,
  payload                     JSONB NOT NULL DEFAULT '{}',
  hidden_at                   TIMESTAMPTZ,
  hidden_by_moderation_action_id TEXT,                                   -- moderation.moderation_action.id, no FK
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'org') = (scope_id IS NULL))
);
-- Reverse-chronological feed query, scoped by chapter (or org-wide when scope_id IS NULL):
--   SELECT * FROM community.feed_entry
--   WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2 AND hidden_at IS NULL
--   ORDER BY id DESC LIMIT 30;
CREATE INDEX idx_feed_entry_scope_created ON community.feed_entry (scope_type, scope_id, id DESC)
  WHERE hidden_at IS NULL;
CREATE UNIQUE INDEX uq_feed_entry_native_source ON community.feed_entry (source_type, source_id)
  WHERE source_event_id IS NULL;
CREATE UNIQUE INDEX uq_feed_entry_source_event ON community.feed_entry (source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE community.kudos (
  id                    TEXT PRIMARY KEY,
  from_person_id        TEXT NOT NULL,                                   -- identity.person.id, no FK
  to_person_id          TEXT NOT NULL,
  note                  TEXT CHECK (char_length(note) <= 280),
  achievement_ref_type  TEXT,                                            -- e.g. 'gamification.badge_award'
  achievement_ref_id    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_person_id <> to_person_id),
  CHECK ((achievement_ref_type IS NULL) = (achievement_ref_id IS NULL))
);
CREATE INDEX idx_kudos_to_person ON community.kudos (to_person_id, id DESC);
CREATE INDEX idx_kudos_from_person ON community.kudos (from_person_id, id DESC);

CREATE TABLE community.team (
  id                  TEXT PRIMARY KEY,
  chapter_id          TEXT NOT NULL,                                     -- identity.chapter.id, no FK
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  created_by_person_id TEXT NOT NULL,                                    -- identity.person.id, no FK
  status              community.team_status NOT NULL DEFAULT 'active',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_team_chapter_name_active ON community.team (chapter_id, name) WHERE status = 'active';

CREATE TABLE community.team_membership (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES community.team (id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL,                                            -- identity.person.id, no FK
  role         community.team_role NOT NULL DEFAULT 'member',
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_team_membership_open ON community.team_membership (team_id, person_id) WHERE left_at IS NULL;
CREATE INDEX idx_team_membership_person ON community.team_membership (person_id) WHERE left_at IS NULL;

CREATE TABLE community.mentorship (
  id                TEXT PRIMARY KEY,
  mentor_person_id  TEXT NOT NULL,                                       -- identity.person.id, no FK
  mentee_person_id  TEXT NOT NULL,
  status            community.mentorship_status NOT NULL DEFAULT 'requested',
  note              TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  CHECK (mentor_person_id <> mentee_person_id)
);
CREATE UNIQUE INDEX uq_mentorship_open_mentee ON community.mentorship (mentee_person_id)
  WHERE status IN ('requested', 'active');
CREATE INDEX idx_mentorship_mentor ON community.mentorship (mentor_person_id, status);

-- Idempotency ledger for consumed external events (see Integration Notes)
CREATE TABLE community.processed_events (
  id            TEXT PRIMARY KEY,                                        -- origin domain_events.id (ULID)
  source_context TEXT NOT NULL,                                          -- 'gamification' | 'volunteering' | 'training' | 'identity'
  event_type    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactional outbox
CREATE TABLE community.domain_events (
  id             TEXT PRIMARY KEY,                                       -- ULID, sortable
  event_type     TEXT NOT NULL,                                          -- e.g. 'KudosGiven'
  aggregate_type TEXT NOT NULL,                                          -- e.g. 'Kudos'
  aggregate_id   TEXT NOT NULL,
  payload        JSONB NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX idx_domain_events_unprocessed ON community.domain_events (id) WHERE processed_at IS NULL;
```

## API Contract Sketch

Internal, module-to-frontend traffic is tRPC; the public `/api/v1/*` REST surface (e.g. `GET /api/v1/feed`, read-only) is a thin wrapper over the same application services and is omitted here for brevity.

```typescript
// src/modules/community/api/trpc/router.ts
export const communityRouter = router({
  createPost: protectedProcedure
    .input(z.object({
      body: z.string().min(1).max(5000),
      scopeType: z.enum(['org', 'chapter']),
      scopeId: ulidSchema.nullable(),
      attachments: z.array(z.object({
        r2ObjectKey: z.string(),
        contentType: z.string(),
        sizeBytes: z.number().int().positive(),
        altText: z.string().optional(),
      })).max(4).default([]),
    }))
    .mutation(...), // -> { postId: string } | throws SCOPE_INVARIANT_VIOLATION

  getFeed: protectedProcedure
    .input(z.object({
      scopeType: z.enum(['org', 'chapter']),
      scopeId: ulidSchema.nullable(),
      cursor: ulidSchema.optional(),   // last-seen feed_entry.id, for keyset pagination
      limit: z.number().int().min(1).max(50).default(30),
    }))
    .query(...), // -> { entries: FeedEntryDTO[], nextCursor: string | null }

  giveKudos: protectedProcedure
    .input(z.object({
      toPersonId: ulidSchema,
      note: z.string().max(280).optional(),
      achievementRefType: z.string().optional(),
      achievementRefId: ulidSchema.optional(),
    }))
    .mutation(...), // -> { kudosId: string }

  getKudosReceived: protectedProcedure
    .input(z.object({ personId: ulidSchema, cursor: ulidSchema.optional() }))
    .query(...), // -> KudosDTO[]

  createTeam: protectedProcedure
    .input(z.object({ chapterId: ulidSchema, name: z.string().min(1).max(80), description: z.string().max(500).optional() }))
    .mutation(...), // -> { teamId: string }

  joinTeam: protectedProcedure
    .input(z.object({ teamId: ulidSchema }))
    .mutation(...), // -> { teamMembershipId: string }

  requestMentorship: protectedProcedure
    .input(z.object({ mentorPersonId: ulidSchema, note: z.string().max(1000).optional() }))
    .mutation(...), // -> { mentorshipId: string } | throws ALREADY_HAS_OPEN_MENTORSHIP

  acceptMentorship: protectedProcedure
    .input(z.object({ mentorshipId: ulidSchema }))
    .mutation(...), // -> { status: 'active', startedAt: string }

  completeMentorship: protectedProcedure
    .input(z.object({ mentorshipId: ulidSchema }))
    .mutation(...), // -> { status: 'completed', endedAt: string }
});

// Admin-only operational procedure, not exposed to volunteers
// src/modules/community/api/trpc/admin-router.ts
export const communityAdminRouter = router({
  rebuildFeedProjection: adminProcedure
    .input(z.object({ scopeType: z.enum(['org', 'chapter']).optional(), scopeId: ulidSchema.optional(), sourceType: z.string().optional() }))
    .mutation(...), // -> { entriesRebuilt: number }
});
```

## Integration & Anti-Corruption Notes

**One handler per consumed external event type — each is its own anti-corruption layer.** This context never joins into `gamification`, `volunteering`, or `training` tables (no cross-schema FK, no cross-schema query, per ADR-0001). Instead, `graphile-worker` drains each of those schemas' `domain_events` outboxes and dispatches to a Community-owned handler:

- `HandleBadgeAwarded(event: gamification.BadgeAwarded)` — checks `community.processed_events` for `event.id`; if absent, inserts a `feed_entry` row (`kind = 'badge_awarded'`, `subjectPersonId = event.payload.personId`, `sourceType = 'gamification.badge_award'`, `sourceId = event.payload.badgeAwardId`, `sourceEventId = event.id`, `summary = "${displayName} earned the ${event.payload.badgeName} badge"`, `payload = { badgeName, badgeIconKey }`), resolving `subjectDisplayName` via `identity.getPersonSummary`, then inserts a `processed_events` row, all in one transaction.
- `HandleHoursApproved(event: volunteering.HoursApproved)` — same shape, `kind = 'hours_approved'`, `payload = { hours, opportunityTitle }`. Scope is taken from the event payload's chapter (Volunteering publishes the Opportunity's chapter on this event), never re-derived by a lookup.
- `HandleCourseCompleted(event: training.CourseCompleted)` — `kind = 'course_completed'`, `payload = { courseTitle }`.
- `HandleStreakExtended(event: gamification.StreakExtended)` — `kind = 'streak_extended'`, but **filtered at the handler**: only milestone streak lengths (7, 30, 100 days, configurable via `admin` feature flag) produce a `FeedEntry`; every other day's `StreakExtended` is acknowledged (written to `processed_events` so it's never reprocessed) but intentionally produces no feed row, to avoid daily feed spam — a product decision, not a technical limitation.

Each handler translates the source context's event vocabulary into this context's own `feed_entry_kind`/`payload` shape; the source schema's internal field names and IDs never leak past the handler into the domain model other modules or the frontend see.

**Idempotency.** `graphile-worker` guarantees at-least-once delivery. Every handler is wrapped in one DB transaction that (a) checks/reserves `community.processed_events.id = event.id`, using the unique PK to make a concurrent double-delivery a no-op via `ON CONFLICT DO NOTHING`, and (b) the `feed_entry` unique indexes (`uq_feed_entry_source_event`, `uq_feed_entry_native_source`) as a second line of defense, so a bug in the `processed_events` check cannot still duplicate a feed row.

**Inbound from Moderation.** `HandleModerationActionTaken` consumes `moderation.ModerationActionTaken`; when `targetResourceType = 'community.post'`, it sets `Post.status = 'hidden'` and `hiddenByModerationActionId`, and separately hides the matching `feed_entry` (native `kind = 'post'` entries are hidden by the Post's own status via the live join at read time — no separate `feed_entry.hidden_at` write needed there; projected `kind`s targeted by moderation directly set `feed_entry.hidden_at`).

**Inbound from Identity (erasure).** `HandlePersonAnonymized` consumes `identity.PersonAnonymized` and, in one transaction, bulk-updates `author_display_name` on `community.post` and `subject_display_name` on `community.feed_entry` for the anonymized `personId` to `'Deleted User'` — content itself is retained (not deleted) to preserve feed/thread integrity, per ADR-0014 §2's erasure design; only the identity-attributable display fields change.

**Never consumed:** raw reads of `identity.person`, `gamification.points_ledger`, `volunteering.hour_entries`, or `training.enrollment` tables. Any display data needed beyond what an event payload carries is fetched exclusively through the publishing context's `index.ts` public interface (Open Host Service reads), never via SQL that crosses a schema boundary.
