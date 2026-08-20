import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can } from "@volunteer-portal/authz";
import { ChapterNotFoundError, ForbiddenActionError, NotAnActiveChapterLeadError } from "../domain/errors";
import { getCallerPolicySubject } from "./getCallerPolicySubject";
import { listActiveRoleAssignments } from "./listActiveRoleAssignments";

/**
 * AssignChapterLead (docs/ddd/identity-access.md, Key Use Case 9).
 *
 * *Pre:* Target Person holds an active `chapter_lead` `RoleAssignment`
 * scoped to this chapter (grant the role first, via `GrantRole`, if not).
 *
 * *Post:* `Chapter.leadPersonId` is updated (soft pointer, no FK);
 * `recordAuditEvent()` tags the outbox write `audit: true`. (No separate
 * domain event is documented for this use case — the Domain Events table
 * lists no `ChapterLeadAssigned` event; `recordAuditEvent()`'s own outbox
 * write is the only `identity.domain_events` row this use case produces.)
 */
export interface AssignChapterLeadInput {
  callerId: string;
  chapterId: string;
  personId: string;
}

export async function assignChapterLead(
  prisma: PrismaClient,
  input: AssignChapterLeadInput,
): Promise<void> {
  const [callerSubject, callerAssignments] = await Promise.all([
    getCallerPolicySubject(prisma, input.callerId, "chapter.assign_lead"),
    listActiveRoleAssignments(prisma, input.callerId),
  ]);
  const allowed = can(
    callerSubject,
    "chapter.assign_lead",
    { type: "chapter", scopeType: "chapter", scopeId: input.chapterId },
    callerAssignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("chapter.assign_lead");
  }

  const chapter = await prisma.chapter.findUnique({ where: { id: input.chapterId }, select: { id: true } });
  if (!chapter) {
    throw new ChapterNotFoundError(input.chapterId);
  }

  // Chapter invariant 2: leadPersonId must correspond to a Person holding
  // an *active* chapter_lead assignment scoped to this exact chapter.
  const targetAssignments = await listActiveRoleAssignments(prisma, input.personId);
  const holdsChapterLead = targetAssignments.some(
    (a) => a.role === "chapter_lead" && a.scopeType === "chapter" && a.scopeId === input.chapterId,
  );
  if (!holdsChapterLead) {
    throw new NotAnActiveChapterLeadError(input.personId, input.chapterId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.chapter.update({
      where: { id: input.chapterId },
      data: { leadPersonId: input.personId },
    });

    await recordAuditEvent(tx.identityDomainEvent, {
      actorId: input.callerId,
      actorType: "user",
      action: "chapter.assign_lead",
      resourceType: "chapter",
      resourceId: input.chapterId,
      metadata: { personId: input.personId },
    });
  });
}
