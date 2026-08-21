import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import { getCourseById, CourseNotFoundError as TrainingCourseNotFoundError } from "@/modules/training";
import type { CourseCompletedPayload } from "../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../domain/errors";
import { recordProcessedEventAndProject, type ProjectionResult } from "./idempotentProjection";

/**
 * `HandleCourseCompleted` (docs/ddd/community-social.md, Integration &
 * Anti-Corruption Notes) — mirrors `training`'s `CourseCompleted`
 * producer (`application/moduleCompletion.ts`). Resolves
 * `subjectDisplayName` via `identity.getPersonSummary` and the Course's
 * `title` via `training.getCourseById` (the payload carries only
 * `courseId`). `training.getCourseById` throws its own
 * `CourseNotFoundError` when the id doesn't resolve — translated here into
 * this module's own `SourceRecordNotFoundError` so no other bounded
 * context's error type crosses this handler's own boundary (this
 * handler's own anti-corruption layer, per the doc's framing).
 *
 * Creates an IMMUTABLE snapshot `FeedEntry` (`kind = 'course_completed'`,
 * FeedEntry invariant 1).
 *
 * Scope: `CourseCompleted`'s payload carries no chapter (a Course is
 * org-wide by construction — `docs/ddd/training-learning.md`'s Course
 * aggregate has no `chapterId` of its own), so this projects org-wide
 * (`scopeType: 'org'`), the same default this module uses for every other
 * consumed kind whose payload carries no chapter.
 */
export async function handleCourseCompleted(
  prisma: PrismaClient,
  payload: CourseCompletedPayload,
  sourceEventId: string,
): Promise<ProjectionResult> {
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

  return recordProcessedEventAndProject(
    prisma,
    { id: sourceEventId, sourceContext: "training", eventType: "CourseCompleted" },
    async (tx) => {
      await tx.feedEntry.create({
        data: {
          id: newId(),
          kind: "course_completed",
          scopeType: "org",
          scopeId: null,
          subjectPersonId: payload.personId,
          subjectDisplayName: person.displayName,
          sourceType: "training.course_completion",
          sourceId: payload.enrollmentId,
          sourceEventId,
          summary: `${person.displayName} completed ${courseTitle}`,
          payload: { courseTitle },
        },
      });
    },
  );
}
