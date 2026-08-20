import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can } from "@volunteer-portal/authz";
import { ChapterSlugTakenError, ForbiddenActionError } from "../domain/errors";
import { getCallerPolicySubject } from "./getCallerPolicySubject";
import { listActiveRoleAssignments } from "./listActiveRoleAssignments";

/**
 * CreateChapter (docs/ddd/identity-access.md, Key Use Case 8).
 *
 * *Pre:* Caller has `org_admin` (global); `slug` is unique.
 *
 * *Post:* A `Chapter` row exists with `status = 'active'`; `ChapterCreated`
 * is emitted.
 */
export interface CreateChapterInput {
  callerId: string;
  name: string;
  slug: string;
  city: string;
  region: string | null;
  country: string;
  foundedAt: string | null;
}

export interface CreatedChapter {
  chapterId: string;
}

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export async function createChapter(
  prisma: PrismaClient,
  input: CreateChapterInput,
): Promise<CreatedChapter> {
  const [callerSubject, callerAssignments] = await Promise.all([
    getCallerPolicySubject(prisma, input.callerId, "chapter.create"),
    listActiveRoleAssignments(prisma, input.callerId),
  ]);
  const allowed = can(
    callerSubject,
    "chapter.create",
    { type: "chapter", scopeType: "global", scopeId: null },
    callerAssignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("chapter.create");
  }

  const chapterId = newId();
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.chapter.create({
        data: {
          id: chapterId,
          name: input.name,
          slug: input.slug,
          city: input.city,
          region: input.region,
          country: input.country,
          foundedAt: input.foundedAt ? new Date(input.foundedAt) : null,
        },
        select: { id: true, name: true, slug: true, city: true, country: true, createdAt: true },
      });

      await tx.identityDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "Chapter",
          aggregateId: created.id,
          eventType: "ChapterCreated",
          payload: {
            chapterId: created.id,
            name: created.name,
            slug: created.slug,
            city: created.city,
            country: created.country,
            createdAt: created.createdAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: input.callerId,
        actorType: "user",
        action: "chapter.create",
        resourceType: "chapter",
        resourceId: created.id,
        metadata: { name: created.name, slug: created.slug },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      throw new ChapterSlugTakenError(input.slug);
    }
    throw error;
  }

  return { chapterId };
}
