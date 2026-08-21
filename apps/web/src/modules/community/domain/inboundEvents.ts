/**
 * The anti-corruption vocabulary for events this context consumes but does
 * not own (docs/ddd/community-social.md, "Consumed External Events" table
 * and Integration & Anti-Corruption Notes): `gamification.domain_events`
 * (`BadgeAwarded`, `StreakExtended`), `volunteering.domain_events`
 * (`HoursApproved`), and `training.domain_events` (`CourseCompleted`).
 * These payload shapes mirror exactly what those three modules' own
 * producers write — see `handleBadgeAwarded.ts`/`handleHoursApproved.ts`/
 * `handleCourseCompleted.ts`/`handleStreakExtended.ts`'s own doc comments
 * for the exact producer file each one mirrors. This context has no
 * concept of "badge criteria" or "shift windows" beyond what it needs to
 * translate a fact into a human-readable `FeedEntry`, per that doc's own
 * framing.
 *
 * `PersonAnonymized` (Identity) and `ModerationActionTaken` (Moderation)
 * are also documented consumed events in docs/ddd/community-social.md, but
 * are deliberately out of scope for this stage's Build list (item 2 names
 * exactly these four event types) — `moderation` does not exist yet, and
 * the erasure fan-out handler is left for the stage that builds
 * `HandlePersonAnonymized` across every module that snapshots display
 * names, not just this one.
 */

export const INBOUND_EVENT_TYPES = ["BadgeAwarded", "HoursApproved", "CourseCompleted", "StreakExtended"] as const;
export type InboundEventType = (typeof INBOUND_EVENT_TYPES)[number];

export function isInboundEventType(value: string): value is InboundEventType {
  return (INBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

/** The `community.processed_events.source_context` value for a given `InboundEventType`. */
export function sourceContextForEventType(eventType: InboundEventType): "gamification" | "volunteering" | "training" {
  switch (eventType) {
    case "BadgeAwarded":
    case "StreakExtended":
      return "gamification";
    case "HoursApproved":
      return "volunteering";
    case "CourseCompleted":
      return "training";
  }
}

/** Mirrors `gamification`'s `BadgeAwarded` payload (`application/awardBadge.ts`). */
export interface BadgeAwardedPayload {
  personId: string;
  badgeId: string;
  badgeAwardId: string;
  awardedAt: string;
}

/** Mirrors `volunteering`'s `HoursApproved` payload (`application/approveHours.ts`). */
export interface HoursApprovedPayload {
  hourEntryId: string;
  personId: string;
  opportunityId: string;
  shiftId: string | null;
  chapterId: string | null;
  durationMinutes: number;
  approverPersonId: string;
  approvedAt: string;
}

/** Mirrors `training`'s `CourseCompleted` payload (`application/moduleCompletion.ts`). */
export interface CourseCompletedPayload {
  enrollmentId: string;
  personId: string;
  courseId: string;
  completedAt: string;
}

/** Mirrors `gamification`'s `StreakExtended` payload (`application/updateStreak.ts`). */
export interface StreakExtendedPayload {
  personId: string;
  activityType: string;
  currentLength: number;
}

/** A raw inbound event as read from `gamification.domain_events` / `volunteering.domain_events` / `training.domain_events`. */
export interface InboundEvent {
  /** The source event's own id (ULID) — the idempotency key (`community.processed_events.id`). */
  sourceEventId: string;
  eventType: string;
  payload: unknown;
}
