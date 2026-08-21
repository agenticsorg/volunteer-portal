/**
 * The anti-corruption vocabulary for events this context consumes but does
 * not own (docs/ddd/gamification.md, Integration & Anti-Corruption Notes):
 * `volunteering.domain_events` (`HoursApproved`) and
 * `training.domain_events` (`ModuleCompleted`, `CourseCompleted`). These
 * types mirror exactly the payload shapes those two modules' own producers
 * write (`approveHours.ts`, `moduleCompletion.ts`) — this module has no
 * concept of "hours" or "modules" beyond what it needs to translate a
 * point-earning/streak-qualifying activity, per that doc's own framing.
 */

export const INBOUND_EVENT_TYPES = ["HoursApproved", "ModuleCompleted", "CourseCompleted"] as const;
export type InboundEventType = (typeof INBOUND_EVENT_TYPES)[number];

export function isInboundEventType(value: string): value is InboundEventType {
  return (INBOUND_EVENT_TYPES as readonly string[]).includes(value);
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

/** Mirrors `training`'s `ModuleCompleted` payload (`application/moduleCompletion.ts`). */
export interface ModuleCompletedPayload {
  enrollmentId: string;
  personId: string;
  courseId: string;
  moduleId: string;
}

/** Mirrors `training`'s `CourseCompleted` payload (`application/moduleCompletion.ts`). */
export interface CourseCompletedPayload {
  enrollmentId: string;
  personId: string;
  courseId: string;
  completedAt: string;
}

/** A raw inbound event as read from `volunteering.domain_events` / `training.domain_events`. */
export interface InboundEvent {
  /** The source event's own id (ULID) — the idempotency key (docs/ddd/gamification.md "Source Event"). */
  sourceEventId: string;
  eventType: string;
  payload: unknown;
}
