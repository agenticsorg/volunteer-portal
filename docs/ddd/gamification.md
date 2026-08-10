# Gamification

## Purpose & Scope

The `gamification` bounded context turns activity that happens *elsewhere* — approved volunteer hours, completed training — into secondary, supporting recognition: points, badges, streaks, and scoped leaderboards. Per the research (`02-gamification-and-social.md`), this context is deliberately kept **secondary to real recognition**: this population has high intrinsic motivation, and heavy or controlling gamification measurably backfires (the Swedish volunteer badge study found faster-but-shallower engagement with no net gain; nonprofits copying corporate reward models saw an "engagement cliff"). Consequently this context is designed around three hard rules derived directly from that research and treated as invariants, not preferences:

1. Points are never the primary reward and are never editable outside an immutable, append-only ledger — there is no mutable "point total" column anywhere in this schema.
2. Badges are permanent and shareable on a person's profile, never siloed inside this module — badge data is designed to be read cheaply by `community` for profile rendering.
3. Leaderboards are **always** scoped to a team or a challenge. A global leaderboard is not merely undesirable, it is disallowed at the schema level (see Leaderboard invariants) — global leaderboards demotivate newcomers and this audience does not need externally-imposed competition to stay engaged.

In scope: the points ledger, badge definitions and awards, per-activity streaks with grace/freeze mechanics, and scoped leaderboard projections.

Explicitly out of scope (owned elsewhere): this context does not decide what counts as an approved volunteer hour (`volunteering`), what counts as a completed course or module (`training`), who a person is or what team they belong to (`identity`, `community`), or how/when a person is notified of an award (`notifications`). This context only *reacts* to domain events from those contexts and *publishes* its own for others to react to.

## Ubiquitous Language

| Term | Definition |
|---|---|
| Points Ledger Entry | A single, immutable, append-only fact: "this person gained/lost N points because of this source event." The only source of truth for points — never mutated or deleted. |
| Points Balance | A materialized projection (a rebuildable cache, not a source of truth) summing a person's ledger entries into a current total. |
| Source Event | The originating domain event from another context (e.g. `HoursApproved`, `CourseCompleted`) that justified a Points Ledger Entry; referenced by its own event ID for traceability and idempotency. |
| Badge | A definition of an achievement: criteria, display metadata, and whether it is public/shareable (default: yes — badges are meant to be seen). |
| Badge Award | The fact that one specific Person earned one specific Badge, once, at a point in time. |
| Streak | A per-person, per-activity-type running count of consecutive active periods (e.g. weekly training cadence, weekly shift cadence). |
| Activity Type | The cadence a Streak tracks — e.g. `training_cadence`, `shift_cadence`. Extensible without a schema migration (stored as text with an app-level allow-list, not a hard enum, since new streak types are expected). |
| Freeze | A forgiveness token that protects a Streak from breaking when a period is missed — the grace mechanic (Duolingo-style) that keeps streaks from being pure punish-on-miss. |
| Leaderboard | A read-model ranking of people by points, always scoped to exactly one Team or one Challenge — never global. |
| Leaderboard Scope | A value object: `(scopeType: 'team' \| 'challenge', scopeId)` — the enforced non-global boundary of any leaderboard. |
| Challenge | A time-boxed competitive/collaborative event a leaderboard can be scoped to; owned by `community`, referenced here by ID only. |
| Processed Event | A record that this context has already consumed a given inbound event ID, used to guarantee idempotent (at-most-once-effect) event handling under at-least-once delivery. |

## Aggregates, Entities & Value Objects

### PointsLedgerEntry (Aggregate Root, append-only)
The event-sourced heart of the context. Every point change — award or correction — is a new row; there is no `UPDATE` path.
- `id`, `personId` (ID-only ref to `identity.person`), `points` (signed integer — negative rows are compensating corrections, never a mutation of a prior row), `sourceEventType` (e.g. `HoursApproved`, `CourseCompleted`, `ModuleCompleted`, `ManualAdjustment`), `sourceEventId` (the originating event's own ULID — the idempotency key), `reason` (short human-readable text, required for `ManualAdjustment`), `createdAt`.

**Invariants:**
1. Immutable once written: no application code path performs `UPDATE` or `DELETE` on this table; enforced defensively with a Postgres rule/trigger (see Schema Sketch) in addition to application discipline.
2. Exactly one `PointsLedgerEntry` per `sourceEventId` per `sourceEventType` — enforced by a unique constraint — which is the concrete mechanism behind idempotent event consumption (see Integration Notes).
3. `PointsBalance` (below) is always derivable by `SUM(points) GROUP BY person_id` over this table; it is never treated as authoritative on its own.

### PointsBalance (materialized projection, not an aggregate)
A rebuildable summary table: `personId`, `totalPoints`, `lastLedgerEntryId`, `updatedAt`. Refreshed transactionally alongside each new `PointsLedgerEntry` write (incremental) and fully rebuildable from the ledger by a maintenance job — never hand-edited.

### Badge (Aggregate Root, definition)
- `id`, `slug`, `name`, `description`, `iconUrl`, `criteria` (structured JSON describing the unlock rule, e.g. `{"type":"course_completed","courseId":"..."}` or `{"type":"streak_length","activityType":"shift_cadence","length":8}` — interpreted by the `EvaluateBadgeCriteria` application service, not by the database), `isPublic` (boolean, default `true` — badges are shareable on a profile per the research finding that permanence/visibility, not the badge itself, is what drives value), `active` (boolean — retired badges stay visible on profiles that already earned them but stop being awardable), `createdAt`.

### BadgeAward (Aggregate Root)
- `id`, `personId`, `badgeId`, `sourceEventId` (traceability — which event caused this award), `awardedAt`.

**Invariant:** exactly one `BadgeAward` per `(personId, badgeId)` — enforced by a unique constraint — badge awarding is idempotent by construction; re-processing the same qualifying event a second time is a no-op, not a duplicate award.

### Streak (Aggregate Root)
- `id`, `personId`, `activityType`, `currentLength` (int, consecutive completed periods), `longestLength`, `lastActivityDate` (date, not timestamp — cadence is period-granular), `freezesAvailable` (int, capped and periodically replenished — e.g. max 2, +1 per completed calendar month), `freezesUsedTotal` (int, lifetime count, analytics only), `status` (`active` \| `frozen` \| `broken`), `updatedAt`.

**Invariants:**
1. On a new qualifying activity: if it falls within the current cadence window of `lastActivityDate` (e.g. the same or next ISO week for `shift_cadence`), `currentLength` increments and `status` stays/returns to `active`.
2. If a cadence window is missed entirely: if `freezesAvailable > 0`, the system auto-consumes one freeze (`freezesAvailable -= 1`, `freezesUsedTotal += 1`, `status = 'frozen'`, `currentLength` preserved, publishes `StreakFrozen`) rather than breaking the streak — this is the forgiveness mechanic the research calls out as essential (pure punish-on-miss reduces retention). If `freezesAvailable = 0` and a window is missed, `status = 'broken'`, `currentLength` resets to 0, `longestLength` is preserved, and `StreakBroken` is published.
3. `freezesAvailable` never exceeds a configured cap (application-level constant, currently 2) — replenishment is additive, not unlimited.

### Leaderboard (Read Model / Projection)
Not a transactionally-written aggregate — it is rebuilt from `PointsLedgerEntry` rows filtered by scope and time window, cached into `leaderboard_snapshot` for fast reads.
- Value object **LeaderboardScope**: `(scopeType: 'team' | 'challenge', scopeId)`.

**Invariant (explicit business rule, not merely a convention):** `scopeType` has no valid value meaning "global" — the type itself only admits `'team'` or `'challenge'`. Any application code path or migration that would compute an unscoped, org-wide leaderboard is a defect, not a configuration choice, per the research finding that global leaderboards demotivate newcomers in exactly this kind of high-intrinsic-motivation population.

## Domain Events

### Consumed (from other contexts — this module does not own these)

| Event | Source Context | Handled By |
|---|---|---|
| `HoursApproved` | `volunteering` | Awards points via `RecordPointsForEvent`; extends `shift_cadence` streak. |
| `ModuleCompleted` | `training` | Awards points; evaluates module-level badge criteria. |
| `CourseCompleted` | `training` | Awards points (larger than a single module); extends `training_cadence` streak; evaluates course-completion badge criteria. |

### Published (consumed downstream by Notifications and Community)

| Event | Payload (key fields) | Emitted When |
|---|---|---|
| `PointsAwarded` | `personId`, `points`, `ledgerEntryId`, `sourceEventType` | A new `PointsLedgerEntry` is written with `points > 0`. |
| `BadgeAwarded` | `personId`, `badgeId`, `badgeAwardId`, `awardedAt` | A new `BadgeAward` row is created. |
| `StreakExtended` | `personId`, `activityType`, `currentLength` | A `Streak` increments without using a freeze. |
| `StreakFrozen` | `personId`, `activityType`, `freezesRemaining` | A missed window is covered by a freeze instead of breaking the streak. |
| `StreakBroken` | `personId`, `activityType`, `previousLength` | A missed window with no freezes available resets the streak. |

## Key Use Cases / Application Services

1. **ConsumeInboundEvent** — the generic, idempotent entry point for every subscribed event (`HoursApproved`, `ModuleCompleted`, `CourseCompleted`): checks `processed_events` for the source event ID within the same transaction as any resulting writes; if already processed, no-ops; otherwise dispatches to the specific handler below and records the event as processed.
2. **RecordPointsForEvent** — given a source event, inserts a `PointsLedgerEntry`, updates `PointsBalance` incrementally, publishes `PointsAwarded`. Point values per source-event type are configuration (e.g. `HoursApproved` → 10 pts/hour, `ModuleCompleted` → 25 pts, `CourseCompleted` → 100 pts), not hardcoded per call site.
3. **EvaluateBadgeCriteria** — runs after a points/streak-affecting event is processed; checks active `Badge.criteria` against the person's current state (ledger totals, completed courses, streak lengths) and calls `AwardBadge` for any newly-satisfied, not-yet-awarded badge.
4. **AwardBadge** — idempotent insert into `badge_award` (`ON CONFLICT (person_id, badge_id) DO NOTHING`), publishes `BadgeAwarded` only if a row was actually inserted.
5. **UpdateStreak** — given a qualifying activity event and its `activityType`, applies the Streak invariants above (extend, freeze, or break), publishes `StreakExtended` / `StreakFrozen` / `StreakBroken` accordingly.
6. **RebuildLeaderboardSnapshot** — scheduled/on-demand job: recomputes `leaderboard_snapshot` rows for a given `LeaderboardScope` and time window directly from `points_ledger_entry`, never from `leaderboard_snapshot` itself (it is a cache of a cache would be a bug).
7. **GetLeaderboard** — query-only; reads `leaderboard_snapshot` for a required, validated `(scopeType, scopeId)` pair — the API layer rejects any request that omits a scope.
8. **GetPersonGamificationProfile** — query-only; returns a person's `PointsBalance`, `BadgeAward` list (with badge detail), and active `Streak`s for profile/portfolio display (consumed by `community`).
9. **AdminAdjustPoints** — staff-only escape hatch that inserts a `ManualAdjustment` `PointsLedgerEntry` (positive or negative) with a required `reason`, for corrections — never edits or removes existing rows.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS gamification;

CREATE TYPE gamification.streak_status AS ENUM ('active', 'frozen', 'broken');
CREATE TYPE gamification.leaderboard_scope_type AS ENUM ('team', 'challenge'); -- 'global' intentionally does not exist

CREATE TABLE gamification.points_ledger_entry (
  id               TEXT PRIMARY KEY,                              -- ULID
  person_id        TEXT NOT NULL,                                 -- identity.person.id, no FK
  points           INTEGER NOT NULL,                               -- signed; negative = correction
  source_event_type TEXT NOT NULL,                                -- 'HoursApproved' | 'CourseCompleted' | 'ModuleCompleted' | 'ManualAdjustment'
  source_event_id  TEXT NOT NULL,                                  -- originating event's ULID; idempotency key
  reason           TEXT,                                           -- required (app-enforced) for ManualAdjustment
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_event_type, source_event_id)
);
CREATE INDEX idx_points_ledger_person ON gamification.points_ledger_entry (person_id, created_at DESC);

-- Defense-in-depth: the ledger is append-only at the database level too.
CREATE RULE points_ledger_no_update AS ON UPDATE TO gamification.points_ledger_entry DO INSTEAD NOTHING;
CREATE RULE points_ledger_no_delete AS ON DELETE TO gamification.points_ledger_entry DO INSTEAD NOTHING;

CREATE TABLE gamification.points_balance (
  person_id            TEXT PRIMARY KEY,
  total_points         BIGINT NOT NULL DEFAULT 0,
  last_ledger_entry_id TEXT,                                       -- points_ledger_entry.id, informational
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gamification.badge (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_url    TEXT,
  criteria    JSONB NOT NULL,
  is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gamification.badge_award (
  id               TEXT PRIMARY KEY,
  person_id        TEXT NOT NULL,                                  -- identity.person.id, no FK
  badge_id         TEXT NOT NULL REFERENCES gamification.badge (id) ON DELETE RESTRICT,
  source_event_id  TEXT,                                           -- traceability, nullable for admin-granted badges
  awarded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, badge_id)
);
CREATE INDEX idx_badge_award_person ON gamification.badge_award (person_id);

CREATE TABLE gamification.streak (
  id                  TEXT PRIMARY KEY,
  person_id           TEXT NOT NULL,                               -- identity.person.id, no FK
  activity_type       TEXT NOT NULL,                                -- 'training_cadence' | 'shift_cadence' | ...
  current_length      INTEGER NOT NULL DEFAULT 0,
  longest_length       INTEGER NOT NULL DEFAULT 0,
  last_activity_date  DATE,
  freezes_available   SMALLINT NOT NULL DEFAULT 2,
  freezes_used_total  INTEGER NOT NULL DEFAULT 0,
  status              gamification.streak_status NOT NULL DEFAULT 'active',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, activity_type)
);

CREATE TABLE gamification.leaderboard_snapshot (
  id            TEXT PRIMARY KEY,
  scope_type    gamification.leaderboard_scope_type NOT NULL,
  scope_id      TEXT NOT NULL,                                     -- community.team.id or community.challenge.id, no FK
  person_id     TEXT NOT NULL,
  rank          INTEGER NOT NULL,
  points        BIGINT NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, person_id, period_start)
);
CREATE INDEX idx_leaderboard_scope_rank
  ON gamification.leaderboard_snapshot (scope_type, scope_id, period_start, rank);

-- Idempotent inbound event consumption
CREATE TABLE gamification.processed_events (
  source_event_id TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_event_id, event_type)
);

-- Transactional outbox for this context's own published events
CREATE TABLE gamification.domain_events (
  id             TEXT PRIMARY KEY,                                 -- ULID, sortable
  event_type     TEXT NOT NULL,                                    -- e.g. 'BadgeAwarded'
  aggregate_type TEXT NOT NULL,                                    -- e.g. 'BadgeAward'
  aggregate_id   TEXT NOT NULL,
  payload        JSONB NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX idx_domain_events_unprocessed ON gamification.domain_events (id) WHERE processed_at IS NULL;
```

## API Contract Sketch

```typescript
// src/modules/gamification/api/trpc/router.ts
export const gamificationRouter = router({
  getMyPointsBalance: protectedProcedure
    .query(...), // -> { totalPoints: number, updatedAt: string }

  getPersonGamificationProfile: publicProcedure
    .input(z.object({ personId: ulidSchema }))
    .query(...), // -> { totalPoints: number, badges: BadgeAwardDTO[], streaks: StreakDTO[] }

  listBadges: publicProcedure
    .input(z.object({ activeOnly: z.boolean().default(true) }))
    .query(...), // -> BadgeDTO[]

  getLeaderboard: protectedProcedure
    .input(z.object({
      scopeType: z.enum(['team', 'challenge']),   // 'global' is not a representable value
      scopeId: ulidSchema,
      periodStart: z.string().datetime().optional(),
    }))
    .query(...), // -> { scope: LeaderboardScope, entries: { personId, rank, points }[] }

  getMyStreak: protectedProcedure
    .input(z.object({ activityType: z.string() }))
    .query(...), // -> StreakDTO | null

  // Staff-only
  adminAdjustPoints: adminProcedure
    .input(z.object({ personId: ulidSchema, points: z.number().int(), reason: z.string().min(1) }))
    .mutation(...), // -> { ledgerEntryId: string }

  adminAwardBadge: adminProcedure
    .input(z.object({ personId: ulidSchema, badgeId: ulidSchema }))
    .mutation(...), // -> { badgeAwardId: string, alreadyAwarded: boolean }
});
```

## Integration & Anti-Corruption Notes

**Inbound: consuming events this context doesn't own.** `gamification` never queries `volunteering` or `training` tables directly (no cross-schema joins, per ADR-0001) and never calls into their application code synchronously. Instead, `graphile-worker` drains `volunteering.domain_events` and `training.domain_events` and dispatches matching event types (`HoursApproved`, `ModuleCompleted`, `CourseCompleted`) to this module's `ConsumeInboundEvent` handler. This is itself an anti-corruption layer: the handler maps each producing context's event payload onto this context's own generic vocabulary (a "point-earning activity" with a `personId`, a `sourceEventType`, and a `sourceEventId`) — `gamification`'s domain model has no concept of "hours" or "modules," only of point-earning and streak-qualifying activities, so a future rename or restructuring inside `training` or `volunteering` cannot ripple into this schema as long as the published event contract's field names stay stable (contract changes are versioned events, not silent breaking changes).

**Idempotent consumption, concretely.** Because `graphile-worker` delivery is at-least-once (a worker can crash after doing the work but before marking the job complete, causing redelivery), every handler in `ConsumeInboundEvent` runs inside a single database transaction that: (1) attempts `INSERT INTO gamification.processed_events (source_event_id, event_type) VALUES (...)`; (2) if that insert violates the primary key (event already processed), the transaction is a no-op and returns immediately — no ledger row, no badge, no streak update, no re-published event; (3) if the insert succeeds, the transaction proceeds to write the `PointsLedgerEntry` (itself additionally guarded by its own `UNIQUE (source_event_type, source_event_id)` constraint as a second, independent idempotency backstop) and any resulting badge/streak changes, all committed atomically together with the `processed_events` row. This guarantees redelivery of the same source event can never double-award points or double-award a badge, even if `processed_events` and `points_ledger_entry` were ever out of sync.

**Outbound: what Notifications and Community consume.** This context publishes `PointsAwarded`, `BadgeAwarded`, `StreakExtended`, `StreakFrozen`, and `StreakBroken` to its own `gamification.domain_events` outbox. `notifications` subscribes to all of them to drive in-app/email nudges ("you're on a 4-week streak!"); `community` subscribes to `BadgeAwarded` to render badges on public profiles and activity feeds, and reads `getPersonGamificationProfile` synchronously for profile-page rendering rather than duplicating badge/points data into its own schema — this is a deliberate exception to "modules only talk via events," permitted because it is a same-process, in-transaction-safe read through this module's published `index.ts` interface, not a cross-schema join.
