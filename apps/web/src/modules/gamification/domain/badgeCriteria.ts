/**
 * `Badge.criteria` (docs/ddd/gamification.md, "Badge" aggregate) — structured
 * JSON describing a badge's unlock rule, interpreted here by
 * `EvaluateBadgeCriteria` (`application/evaluateBadgeCriteria.ts`), never by
 * the database. Only the two shapes the doc gives as worked examples are
 * implemented (`course_completed`, `streak_length`); `points_total` is added
 * as the same kind of simple, self-contained threshold rule, gated on the
 * total-points figure `RecordPointsForEvent` already computes on every
 * award, so evaluating it costs nothing extra per event.
 */

export type BadgeCriteria =
  | { type: "course_completed"; courseId: string }
  | { type: "module_completed"; moduleId: string }
  | { type: "streak_length"; activityType: string; length: number }
  | { type: "points_total"; threshold: number };

/**
 * The subset of a person's just-updated state relevant to badge evaluation,
 * assembled by whichever `handle*` consumer ran (`handleHoursApproved.ts`
 * etc.) from the values `RecordPointsForEvent`/`UpdateStreak` just computed
 * in the same transaction — never a fresh query over the person's entire
 * history, since a badge can only newly become satisfied by *this* event's
 * effect (points balance, or the streak/course/module this event pertains
 * to).
 */
export interface BadgeEvaluationContext {
  personId: string;
  /** Traceability — which inbound event triggered this evaluation pass. */
  sourceEventId: string;
  totalPoints?: number | bigint;
  courseCompletedId?: string;
  moduleCompletedId?: string;
  streak?: { activityType: string; currentLength: number };
}

/** Runtime shape check for a `Badge.criteria` JSON value — staff-authored data, but never blindly cast. */
export function parseBadgeCriteria(value: unknown): BadgeCriteria | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "course_completed":
      return typeof record.courseId === "string" ? { type: "course_completed", courseId: record.courseId } : null;
    case "module_completed":
      return typeof record.moduleId === "string" ? { type: "module_completed", moduleId: record.moduleId } : null;
    case "streak_length":
      return typeof record.activityType === "string" && typeof record.length === "number"
        ? { type: "streak_length", activityType: record.activityType, length: record.length }
        : null;
    case "points_total":
      return typeof record.threshold === "number" ? { type: "points_total", threshold: record.threshold } : null;
    default:
      return null;
  }
}

export function isCriteriaSatisfied(criteria: BadgeCriteria, ctx: BadgeEvaluationContext): boolean {
  switch (criteria.type) {
    case "course_completed":
      return ctx.courseCompletedId === criteria.courseId;
    case "module_completed":
      return ctx.moduleCompletedId === criteria.moduleId;
    case "streak_length":
      return ctx.streak !== undefined && ctx.streak.activityType === criteria.activityType && ctx.streak.currentLength >= criteria.length;
    case "points_total":
      return ctx.totalPoints !== undefined && Number(ctx.totalPoints) >= criteria.threshold;
  }
}
