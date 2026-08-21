import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import {
  MentorshipNotFoundError,
  MentorshipNotRequestedError,
  NotTheMentorError,
  PersonNotFoundError,
} from "../domain/errors";
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
 * accept it, and only while `status = 'requested'`. Sets `startedAt`,
 * creates a native `FeedEntry` (`kind = 'mentorship_started'`) — org-scoped,
 * the same default `giveKudos.ts` uses for Kudos, since Mentorship (like
 * Kudos) carries no chapter/scope field of its own — and emits
 * `MentorshipStarted`.
 *
 * `FeedEntry.subjectPersonId` is the *mentee* (mirrors `giveKudos.ts`'s
 * choice of the recipient, not the actor, as the subject the entry is
 * about).
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

  const [mentor, mentee] = await Promise.all([
    getPersonSummary(prisma, mentorship.mentorPersonId),
    getPersonSummary(prisma, mentorship.menteePersonId),
  ]);
  if (!mentor) throw new PersonNotFoundError(mentorship.mentorPersonId);
  if (!mentee) throw new PersonNotFoundError(mentorship.menteePersonId);

  const startedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.mentorship.update({
      where: { id: input.mentorshipId, status: "requested" },
      data: { status: "active", startedAt },
    });

    await tx.feedEntry.create({
      data: {
        id: newId(),
        kind: "mentorship_started",
        scopeType: "org",
        scopeId: null,
        subjectPersonId: mentorship.menteePersonId,
        subjectDisplayName: mentee.displayName,
        sourceType: "community.mentorship",
        sourceId: input.mentorshipId,
        sourceEventId: null,
        summary: `${mentor.displayName} started mentoring ${mentee.displayName}`,
        payload: { mentorPersonId: mentorship.mentorPersonId, menteePersonId: mentorship.menteePersonId },
      },
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
