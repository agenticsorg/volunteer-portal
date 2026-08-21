/**
 * The anti-corruption vocabulary for the eight external event types this
 * context consumes (docs/plans/implementation-plan.md's Phase 8 Build
 * item 2; docs/ddd/notifications.md's "Consumed" event table): `HoursApproved`
 * (`volunteering`), `BadgeAwarded`/`StreakBroken` (`gamification`),
 * `CourseCompleted`/`CertificateIssued` (`training`), `KudosGiven`/
 * `MentorshipStarted` (`community`), `ModerationActionTaken` (`moderation`).
 * (`MentionCreated` and `ExportJobCompleted`, also listed in the ddd doc's
 * fuller "Consumed" table, are out of scope for this stage — `community`
 * has no `MentionCreated` producer yet and `admin`'s `ExportJobCompleted`
 * doesn't exist until Phase 9.)
 *
 * These payload shapes mirror exactly what each source module's own
 * producer writes to its own `domain_events` outbox — see each handler
 * file's own doc comment for the exact producer file it mirrors. This
 * context has no concept of "hour entries" or "badge criteria" beyond what
 * it needs to translate a fact into a `QueueNotification` command, per
 * docs/ddd/notifications.md's own Integration & Anti-Corruption Notes.
 */

export const INBOUND_EVENT_TYPES = [
  "HoursApproved",
  "BadgeAwarded",
  "StreakBroken",
  "CourseCompleted",
  "CertificateIssued",
  "KudosGiven",
  "MentorshipStarted",
  "ModerationActionTaken",
] as const;

export type InboundEventType = (typeof INBOUND_EVENT_TYPES)[number];

export function isInboundEventType(value: string): value is InboundEventType {
  return (INBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

/** `notifications.notification.source_context` / `notifications.processed_events.source_context` value for a given source schema. */
export type SourceContext = "volunteering" | "training" | "gamification" | "community" | "moderation" | "admin" | "notifications";

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

/** Mirrors `gamification`'s `BadgeAwarded` payload (`application/awardBadge.ts`). */
export interface BadgeAwardedPayload {
  personId: string;
  badgeId: string;
  badgeAwardId: string;
  awardedAt: string;
}

/** Mirrors `gamification`'s `StreakBroken` payload (`application/updateStreak.ts`). */
export interface StreakBrokenPayload {
  personId: string;
  activityType: string;
  previousLength: number;
}

/** Mirrors `training`'s `CourseCompleted` payload (`application/moduleCompletion.ts`). */
export interface CourseCompletedPayload {
  enrollmentId: string;
  personId: string;
  courseId: string;
  completedAt: string;
}

/** Mirrors `training`'s `CertificateIssued` payload (`application/moduleCompletion.ts`). */
export interface CertificateIssuedPayload {
  certificateId: string;
  personId: string;
  courseId: string;
  certificateNumber: string;
}

/** Mirrors `community`'s `KudosGiven` payload (`application/giveKudos.ts`). */
export interface KudosGivenPayload {
  kudosId: string;
  fromPersonId: string;
  toPersonId: string;
  achievementRefType: string | null;
  achievementRefId: string | null;
}

/** Mirrors `community`'s `MentorshipStarted` payload (`application/acceptMentorship.ts`). */
export interface MentorshipStartedPayload {
  mentorshipId: string;
  mentorPersonId: string;
  menteePersonId: string;
}

/** Mirrors `moderation`'s `ModerationActionTaken` payload (`application/takeModerationAction.ts`). */
export interface ModerationActionTakenPayload {
  actionId: string;
  actionType: "warn" | "mute" | "suspend" | "ban";
  targetPersonId: string;
  moderatorPersonId: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  endsAt: string | null;
}

/** A raw inbound event as read from a source schema's `domain_events` table. */
export interface InboundEvent {
  /** The source event's own id (ULID) — the idempotency key (`notifications.processed_events.id`). */
  sourceEventId: string;
  eventType: string;
  payload: unknown;
}
