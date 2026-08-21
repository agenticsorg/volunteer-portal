/**
 * Point values per source-event type (docs/ddd/gamification.md,
 * `RecordPointsForEvent`: "Point values per source-event type are
 * configuration ... not hardcoded per call site"). Kept as one small,
 * central table so a future tuning pass changes one file, not every event
 * handler.
 */

/** `HoursApproved` -> points per hour of approved volunteer time. */
export const POINTS_PER_HOUR = 10;

/** `ModuleCompleted` -> flat points per completed training module. */
export const POINTS_FOR_MODULE_COMPLETED = 25;

/** `CourseCompleted` -> flat points per completed course (larger than a single module, per the doc). */
export const POINTS_FOR_COURSE_COMPLETED = 100;

/** `HoursApproved` awards `POINTS_PER_HOUR` per hour, prorated for partial hours and rounded to a whole point. */
export function computeHoursApprovedPoints(durationMinutes: number): number {
  return Math.round((durationMinutes / 60) * POINTS_PER_HOUR);
}
