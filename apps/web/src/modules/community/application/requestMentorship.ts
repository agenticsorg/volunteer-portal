import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import { AlreadyHasOpenMentorshipError, PersonNotFoundError, SelfMentorshipNotAllowedError } from "../domain/errors";
import { publishCommunityEvent } from "./publishCommunityEvent";

export interface RequestMentorshipInput {
  caller: PolicySubject;
  mentorPersonId: string;
  note?: string;
}

export interface RequestedMentorship {
  mentorshipId: string;
}

/**
 * RequestMentorship (docs/ddd/community-social.md, Key Use Case 5). The
 * caller is always the mentee (API Contract Sketch's `requestMentorship`
 * takes only `mentorPersonId`, never a separate `menteePersonId` — same
 * "caller = self" shape as `volunteering`'s `submitHours`). Validates
 * Mentorship invariant 1 (`mentorPersonId <> menteePersonId`) and
 * invariant 2 (the mentee has no other open `requested`/`active`
 * Mentorship — enforced explicitly here as a friendly domain error ahead
 * of the DB's own `uq_mentorship_open_mentee` partial unique index),
 * creates the pairing `status = 'requested'`, and emits
 * `MentorshipRequested`.
 */
export async function requestMentorship(
  prisma: PrismaClient,
  input: RequestMentorshipInput,
): Promise<RequestedMentorship> {
  if (input.caller.id === input.mentorPersonId) {
    throw new SelfMentorshipNotAllowedError();
  }

  const mentor = await getPersonSummary(prisma, input.mentorPersonId);
  if (!mentor) {
    throw new PersonNotFoundError(input.mentorPersonId);
  }

  const existingOpen = await prisma.mentorship.findFirst({
    where: { menteePersonId: input.caller.id, status: { in: ["requested", "active"] } },
    select: { id: true },
  });
  if (existingOpen) {
    throw new AlreadyHasOpenMentorshipError(input.caller.id);
  }

  const mentorshipId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.mentorship.create({
      data: {
        id: mentorshipId,
        mentorPersonId: input.mentorPersonId,
        menteePersonId: input.caller.id,
        note: input.note ?? null,
      },
    });

    await publishCommunityEvent(tx, {
      eventType: "MentorshipRequested",
      aggregateType: "Mentorship",
      aggregateId: mentorshipId,
      payload: { mentorshipId, mentorPersonId: input.mentorPersonId, menteePersonId: input.caller.id },
    });

    await recordAuditEvent(tx.communityDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "mentorship.request",
      resourceType: "mentorship",
      resourceId: mentorshipId,
      metadata: { mentorPersonId: input.mentorPersonId },
    });
  });

  return { mentorshipId };
}
