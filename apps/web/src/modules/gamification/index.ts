/**
 * gamification bounded-context module — public interface.
 *
 * Gamification — points ledger, badges, streaks, team/challenge-scoped
 * leaderboard projections.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/ and application/ in this module is private and must never be
 * imported directly by another module — see the module-boundary lint rule
 * (eslint.config.mjs) for enforcement.
 *
 * Phase 5 scope, this stage: the domain/application layer only — every
 * aggregate/invariant and Key Use Case from docs/ddd/gamification.md
 * (PointsLedgerEntry, Badge, BadgeAward, Streak, the scoped Leaderboard
 * projection), gated through `@volunteer-portal/authz`'s `can()` (ADR-0007)
 * exactly the way every other module gates its own staff-only mutations,
 * and consuming `volunteering`/`training`'s domain events idempotently per
 * ADR-0009 (`consumeInboundEvent`, keyed by `gamification.processed_events`
 * — see that function's own doc comment for why it doesn't call
 * `packages/outbox`'s `drainOutbox()` unmodified).
 *
 * Deliberately NOT in this stage (a later stage's job): the tRPC router
 * (`server/api/routers/gamification.ts` stays an empty stub for now — every
 * procedure it eventually gets is a thin adapter over the use cases exported
 * here, same split as every other module) and the graphile-worker task that
 * drains `volunteering.domain_events` / `training.domain_events` and calls
 * `consumeInboundEvent` per row (apps/worker infra, alongside Phase 1's
 * `audit_log_writer` precedent) — this module exports the fully-idempotent
 * consumer logic that task will call, but not the polling/scheduling
 * mechanism itself.
 */

// --- Inbound event consumption (ADR-0009) ---
export { consumeInboundEvent } from "./application/consumeInboundEvent";
export type { ConsumeInboundEventResult } from "./application/consumeInboundEvent";
export { handleHoursApproved } from "./application/handleHoursApproved";
export { handleModuleCompleted } from "./application/handleModuleCompleted";
export { handleCourseCompleted } from "./application/handleCourseCompleted";
export {
  INBOUND_EVENT_TYPES,
  isInboundEventType,
} from "./domain/inboundEvents";
export type {
  InboundEvent,
  InboundEventType,
  HoursApprovedPayload,
  ModuleCompletedPayload,
  CourseCompletedPayload,
} from "./domain/inboundEvents";

// --- Points ---
export { recordPointsForEvent } from "./application/recordPointsForEvent";
export type {
  RecordPointsForEventInput,
  RecordPointsForEventResult,
  SourceEventType,
} from "./application/recordPointsForEvent";

export { getPointsBalance } from "./application/getPointsBalance";
export type { PointsBalanceDTO } from "./application/getPointsBalance";

export { adminAdjustPoints } from "./application/adminAdjustPoints";
export type { AdminAdjustPointsInput, AdminAdjustPointsResult } from "./application/adminAdjustPoints";

// --- Badges ---
export { awardBadge } from "./application/awardBadge";
export type { AwardBadgeInput, AwardBadgeResult } from "./application/awardBadge";

export { evaluateBadgeCriteria } from "./application/evaluateBadgeCriteria";

export { listBadges } from "./application/listBadges";
export type { BadgeDTO, ListBadgesInput } from "./application/listBadges";

export { adminAwardBadge } from "./application/adminAwardBadge";
export type { AdminAwardBadgeInput, AdminAwardBadgeResult } from "./application/adminAwardBadge";

// --- Streaks ---
export { updateStreak } from "./application/updateStreak";
export type { UpdateStreakInput, UpdateStreakResult } from "./application/updateStreak";

export { getMyStreak } from "./application/getMyStreak";

/** Pure streak forgiveness/grace state machine (`updateStreak` uses this internally) — exported for direct unit testing. */
export { applyStreakActivity, initialStreakState, MAX_FREEZES } from "./domain/streakRules";
export type { StreakState, StreakStatus, StreakOutcome } from "./domain/streakRules";

// --- Leaderboards (team/challenge-scoped ONLY — see docs/ddd/gamification.md) ---
export { rebuildLeaderboardSnapshot } from "./application/rebuildLeaderboardSnapshot";
export type { RebuildLeaderboardSnapshotInput } from "./application/rebuildLeaderboardSnapshot";

export { getLeaderboard } from "./application/getLeaderboard";
export type { GetLeaderboardInput, LeaderboardEntry, LeaderboardResult } from "./application/getLeaderboard";

/** Runtime scope guard (`getLeaderboard`/`rebuildLeaderboardSnapshot` use this internally) — exported for direct unit testing. */
export { assertScopedLeaderboard } from "./domain/leaderboardScope";
export type { LeaderboardScope, LeaderboardScopeType } from "./domain/leaderboardScope";

// --- Profile (the cross-context read `community` calls synchronously) ---
export { getPersonGamificationProfile } from "./application/getPersonGamificationProfile";
export type {
  PersonGamificationProfile,
  BadgeAwardDTO,
  StreakDTO,
} from "./application/getPersonGamificationProfile";

/** Point-value configuration (`RecordPointsForEvent` uses this internally) — exported for direct unit testing. */
export {
  POINTS_PER_HOUR,
  POINTS_FOR_MODULE_COMPLETED,
  POINTS_FOR_COURSE_COMPLETED,
  computeHoursApprovedPoints,
} from "./domain/pointsConfig";

/** Pure `Badge.criteria` evaluation (`evaluateBadgeCriteria` uses this internally) — exported for direct unit testing. */
export { parseBadgeCriteria, isCriteriaSatisfied } from "./domain/badgeCriteria";
export type { BadgeCriteria, BadgeEvaluationContext } from "./domain/badgeCriteria";

export {
  ForbiddenActionError,
  UnscopedLeaderboardError,
  ManualAdjustmentReasonRequiredError,
  BadgeNotFoundError,
  PersonNotFoundError,
} from "./domain/errors";
