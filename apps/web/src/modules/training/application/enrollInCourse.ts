import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import { CourseNotFoundError, CourseNotPublishedError, DuplicateActiveEnrollmentError, PersonNotFoundError } from "../domain/errors";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * EnrollInCourse (docs/ddd/training-learning.md, Key Use Case 6).
 * Self-service — the learner acts on their own behalf, same shape as
 * `volunteering`'s `applyToShift` — not `can()`-gated.
 *
 * *Pre:* Course is `published`; no `active` Enrollment already exists for
 * `(personId, courseId)` (Enrollment invariant 1 — the DB's
 * `uq_enrollment_active_person_course` partial unique index is the real
 * concurrency backstop, same "pre-check + unique-constraint backstop"
 * shape used throughout this codebase).
 *
 * *Post:* a new `Enrollment(status = 'active')` row exists; a
 * `ModuleProgress(status = 'not_started')` row is seeded for every Module
 * in the course (so `RecordProgress`/resume-where-left-off always has a
 * row to update, never needing an upsert-or-create branch later);
 * `EnrollmentStarted` emitted.
 */
export interface EnrollInCourseInput {
  personId: string;
  courseId: string;
}

export interface EnrolledCourse {
  enrollmentId: string;
}

export async function enrollInCourse(prisma: PrismaClient, input: EnrollInCourseInput): Promise<EnrolledCourse> {
  const person = await getPersonSummary(prisma, input.personId);
  if (!person) {
    throw new PersonNotFoundError(input.personId);
  }

  const course = await prisma.course.findUnique({
    where: { id: input.courseId },
    select: { id: true, status: true, modules: { select: { id: true } } },
  });
  if (!course) {
    throw new CourseNotFoundError(input.courseId);
  }
  if (course.status !== "published") {
    throw new CourseNotPublishedError(course.id);
  }

  const existingActive = await prisma.enrollment.findFirst({
    where: { personId: input.personId, courseId: input.courseId, status: "active" },
    select: { id: true },
  });
  if (existingActive) {
    throw new DuplicateActiveEnrollmentError(input.personId, input.courseId);
  }

  const enrollmentId = newId();
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.enrollment.create({
        data: { id: enrollmentId, personId: input.personId, courseId: input.courseId },
        select: { id: true, personId: true, courseId: true, enrolledAt: true },
      });

      if (course.modules.length > 0) {
        await tx.moduleProgress.createMany({
          data: course.modules.map((m) => ({ id: newId(), enrollmentId, moduleId: m.id })),
        });
      }

      await tx.trainingDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "Enrollment",
          aggregateId: created.id,
          eventType: "EnrollmentStarted",
          payload: {
            enrollmentId: created.id,
            personId: created.personId,
            courseId: created.courseId,
          } satisfies Prisma.InputJsonValue,
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      throw new DuplicateActiveEnrollmentError(input.personId, input.courseId);
    }
    throw error;
  }

  return { enrollmentId };
}
