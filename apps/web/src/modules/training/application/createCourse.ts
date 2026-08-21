import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { assertTrainingAuthority } from "./assertTrainingAuthority";

/**
 * CreateCourse (docs/ddd/training-learning.md, Key Use Case 1).
 *
 * *Pre:* caller holds `content_admin` (global) or `org_admin`.
 *
 * *Post:* a new `Course(status = 'draft')` row exists. No domain event is
 * emitted — the Domain Events table's first Course-lifecycle event is
 * `CoursePublished`; a still-`draft` row is not yet visible to any other
 * bounded context (same "no event on create" precedent as
 * `volunteering`'s `createOpportunity`).
 */
export interface CreateCourseInput {
  caller: PolicySubject;
  slug: string;
  title: string;
  description?: string;
  passingCertificateEnabled?: boolean;
}

export interface CreatedCourse {
  courseId: string;
}

export async function createCourse(prisma: PrismaClient, input: CreateCourseInput): Promise<CreatedCourse> {
  await assertTrainingAuthority(prisma, input.caller, "course.manage");

  const courseId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.course.create({
      data: {
        id: courseId,
        slug: input.slug,
        title: input.title,
        description: input.description ?? "",
        passingCertificateEnabled: input.passingCertificateEnabled ?? true,
        createdByPersonId: input.caller.id,
      },
    });

    await recordAuditEvent(tx.trainingDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "course.create",
      resourceType: "course",
      resourceId: courseId,
      scopeType: "global",
      metadata: { slug: input.slug, title: input.title },
    });
  });

  return { courseId };
}
