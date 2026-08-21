import { Prisma } from "@prisma/client";
import type { CourseCompletedPayload } from "../domain/inboundEvents";
import { POINTS_FOR_COURSE_COMPLETED } from "../domain/pointsConfig";
import { recordPointsForEvent } from "./recordPointsForEvent";
import { updateStreak } from "./updateStreak";
import { evaluateBadgeCriteria } from "./evaluateBadgeCriteria";

/**
 * `CourseCompleted` (from `training`, docs/ddd/gamification.md's Consumed
 * Domain Events table): "Awards points (larger than a single module);
 * extends `training_cadence` streak; evaluates course-completion badge
 * criteria." Called by `consumeInboundEvent` only after the
 * `processed_events` idempotency check has already succeeded.
 */
export async function handleCourseCompleted(
  tx: Prisma.TransactionClient,
  payload: CourseCompletedPayload,
  sourceEventId: string,
): Promise<void> {
  const { totalPoints } = await recordPointsForEvent(tx, {
    personId: payload.personId,
    points: POINTS_FOR_COURSE_COMPLETED,
    sourceEventType: "CourseCompleted",
    sourceEventId,
  });

  const streak = await updateStreak(tx, {
    personId: payload.personId,
    activityType: "training_cadence",
    activityDate: new Date(payload.completedAt),
  });

  await evaluateBadgeCriteria(tx, {
    personId: payload.personId,
    sourceEventId,
    totalPoints,
    courseCompletedId: payload.courseId,
    streak: { activityType: "training_cadence", currentLength: streak.currentLength },
  });
}
