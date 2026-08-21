import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import { getCourseById, CourseNotFoundError as TrainingCourseNotFoundError } from "@/modules/training";
import type { CourseCompletedPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleCourseCompleted` — mirrors `training`'s `CourseCompleted`
 * producer (`application/moduleCompletion.ts`). The payload carries only
 * `courseId`, so the Course's `title` is resolved via
 * `training.getCourseById` — same cross-context read shape `community`'s
 * own `handleCourseCompleted.ts` already established. `getCourseById`
 * throws its own `CourseNotFoundError` when the id doesn't resolve —
 * translated here into this module's own `SourceRecordNotFoundError` so no
 * other bounded context's error type crosses this handler's own boundary.
 *
 * Recipient: `payload.personId`. `course_completed` is the one social/
 * engagement type whose email channel defaults OFF (in-app only) — still
 * requested on both here; the QUEUE-TIME gate is what actually applies
 * that default, not this handler.
 */
export async function handleCourseCompleted(
  prisma: PrismaClient,
  payload: CourseCompletedPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const person = await getPersonSummary(prisma, payload.personId);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }

  let courseTitle: string;
  try {
    const course = await getCourseById(prisma, payload.courseId);
    courseTitle = course.title;
  } catch (error) {
    if (error instanceof TrainingCourseNotFoundError) {
      throw new SourceRecordNotFoundError("training.course", payload.courseId);
    }
    throw error;
  }

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "training", eventType: "CourseCompleted" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.personId,
        type: "course_completed",
        requestedChannels: ["email", "in_app"],
        sourceContext: "training",
        sourceEventId,
        payload: { enrollmentId: payload.enrollmentId, courseTitle },
      });
    },
  );
}
