import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { CourseNotFoundError, CourseNotPublishableError, InvalidCourseTransitionError } from "../domain/errors";
import { findCaptionGateBlocker } from "../domain/captionGate";
import { assertTrainingAuthority } from "./assertTrainingAuthority";

/**
 * PublishCourse (docs/ddd/training-learning.md, Key Use Case 5; Course
 * invariant 3; ADR-0010's mandatory publish gate). **This is the hard
 * caption-approval gate** — no code path in this module bypasses it: a
 * Course cannot become `published` while any Module's Video has
 * `captionStatus != 'approved'`, or while it has zero Modules. There is no
 * override flag, in this function or anywhere else.
 *
 * *Pre:* Course is `draft`; has >= 1 Module; every Module has a Video, and
 * every one of those Videos has `captionStatus = 'approved'`; caller holds
 * `content_admin` (global) or `org_admin`.
 *
 * *Post:* `status = 'published'`, `publishedAt` set; `CoursePublished`
 * emitted.
 */
export interface PublishCourseInput {
  caller: PolicySubject;
  courseId: string;
}

export interface PublishedCourse {
  status: "published";
  publishedAt: string;
}

export async function publishCourse(prisma: PrismaClient, input: PublishCourseInput): Promise<PublishedCourse> {
  await assertTrainingAuthority(prisma, input.caller, "course.manage");

  const course = await prisma.course.findUnique({
    where: { id: input.courseId },
    select: {
      id: true,
      status: true,
      modules: { select: { id: true, video: { select: { captionStatus: true } } } },
    },
  });
  if (!course) {
    throw new CourseNotFoundError(input.courseId);
  }
  if (course.status !== "draft") {
    throw new InvalidCourseTransitionError(course.id, course.status, "published");
  }
  if (course.modules.length === 0) {
    throw new CourseNotPublishableError(course.id, "the course has zero modules.");
  }
  const blocker = findCaptionGateBlocker(course.modules);
  if (blocker) {
    throw new CourseNotPublishableError(
      course.id,
      `module "${blocker.id}" has no video, or its captions are not approved — ` +
        "every module's video must have captionStatus = 'approved' before a course can publish.",
    );
  }

  let result!: PublishedCourse;
  await prisma.$transaction(async (tx) => {
    const publishedAt = new Date();
    const updated = await tx.course.update({
      where: { id: course.id, status: "draft" },
      data: { status: "published", publishedAt },
      select: { id: true, publishedAt: true },
    });

    await tx.trainingDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Course",
        aggregateId: updated.id,
        eventType: "CoursePublished",
        payload: {
          courseId: updated.id,
          publishedAt: updated.publishedAt!.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.trainingDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "course.publish",
      resourceType: "course",
      resourceId: updated.id,
      scopeType: "global",
    });

    result = { status: "published", publishedAt: updated.publishedAt!.toISOString() };
  });

  return result;
}
