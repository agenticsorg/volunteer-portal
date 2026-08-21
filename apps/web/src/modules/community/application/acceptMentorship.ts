import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { MentorshipNotFoundError, MentorshipNotRequestedError, NotTheMentorError } from "../domain/errors";
import { publishCommunityEvent } from "./publishCommunityEvent";

export interface AcceptMentorshipInput {
  caller: PolicySubject;
  mentorshipId: string;
}

export interface AcceptedMentorship {
  status: "active";
  startedAt: string;
}

/**
 * AcceptMentorship (docs/ddd/community-social.md, Key Use Case 6).
 * Transitions `requested -> active` (Mentorship invariant 3's legal
 * transition table) — only the mentorship's own `mentorPersonId` may
 * accept it, and only while `status = 'requested'`. Sets `startedAt` and
 * emits `MentorshipStarted`.
 */
export async function acceptMentorship(
  prisma: PrismaClient,
  input: AcceptMentorshipInput,
): Promise<AcceptedMentorship> {
  const mentorship = await prisma.mentorship.findUnique({ where: { id: input.mentorshipId } });
  if (!mentorship) {
    throw new MentorshipNotFoundError(input.mentorshipId);
  }
  if (mentorship.mentorPersonId !== input.caller.id) {
    throw new NotTheMentorError(input.mentorshipId);
  }
  if (mentorship.status !== "requested") {
    throw new MentorshipNotRequestedError(input.mentorshipId, mentorship.status);
  }

  const startedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.mentorship.update({
      where: { id: input.mentorshipId, status: "requested" },
      data: { status: "active", startedAt },
    });

    await publishCommunityEvent(tx, {
      eventType: "MentorshipStarted",
      aggregateType: "Mentorship",
      aggregateId: input.mentorshipId,
      payload: {
        mentorshipId: input.mentorshipId,
        mentorPersonId: mentorship.mentorPersonId,
        menteePersonId: mentorship.menteePersonId,
      },
    });

    await recordAuditEvent(tx.communityDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "mentorship.accept",
      resourceType: "mentorship",
      resourceId: input.mentorshipId,
      metadata: { menteePersonId: mentorship.menteePersonId },
    });
  });

  return { status: "active", startedAt: startedAt.toISOString() };
}
