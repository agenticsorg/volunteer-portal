import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import { AchievementReferenceMismatchError, PersonNotFoundError, SelfKudosNotAllowedError } from "../domain/errors";
import { publishCommunityEvent } from "./publishCommunityEvent";

export interface GiveKudosInput {
  caller: PolicySubject;
  toPersonId: string;
  note?: string;
  achievementRefType?: string;
  achievementRefId?: string;
}

export interface GivenKudos {
  kudosId: string;
}

/**
 * GiveKudos (docs/ddd/community-social.md, Key Use Case 2). Validates
 * Kudos invariant 1 (`fromPersonId <> toPersonId`) and invariant 2 (the
 * achievement reference is all-or-nothing), persists the Kudos, creates a
 * native `FeedEntry` (`kind = 'kudos_given'`), and emits `KudosGiven`.
 *
 * `FeedEntry.subjectPersonId` is the *recipient* (`toPersonId`), per
 * FeedEntry's own doc comment ("the Person the entry is about — ... the
 * kudos recipient"), not the giver. Kudos carries no chapter/scope
 * dimension of its own (unlike Post, its aggregate has no `scopeType`
 * field) and docs/ddd/community-social.md's Key Use Case 2 does not derive
 * one from anywhere else, so the projected entry is org-scoped — the same
 * default this module's event-handlers use for every other consumed kind
 * whose source payload carries no chapter of its own (see
 * `handleBadgeAwarded.ts`'s doc comment for the fuller reasoning).
 */
export async function giveKudos(prisma: PrismaClient, input: GiveKudosInput): Promise<GivenKudos> {
  if (input.caller.id === input.toPersonId) {
    throw new SelfKudosNotAllowedError();
  }
  if ((input.achievementRefType === undefined) !== (input.achievementRefId === undefined)) {
    throw new AchievementReferenceMismatchError();
  }

  const [fromPerson, toPerson] = await Promise.all([
    getPersonSummary(prisma, input.caller.id),
    getPersonSummary(prisma, input.toPersonId),
  ]);
  if (!fromPerson) throw new PersonNotFoundError(input.caller.id);
  if (!toPerson) throw new PersonNotFoundError(input.toPersonId);

  const kudosId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.kudos.create({
      data: {
        id: kudosId,
        fromPersonId: input.caller.id,
        toPersonId: input.toPersonId,
        note: input.note ?? null,
        achievementRefType: input.achievementRefType ?? null,
        achievementRefId: input.achievementRefId ?? null,
      },
    });

    await tx.feedEntry.create({
      data: {
        id: newId(),
        kind: "kudos_given",
        scopeType: "org",
        scopeId: null,
        subjectPersonId: input.toPersonId,
        subjectDisplayName: toPerson.displayName,
        sourceType: "community.kudos",
        sourceId: kudosId,
        sourceEventId: null,
        summary: `${fromPerson.displayName} gave kudos to ${toPerson.displayName}`,
        payload: {
          note: input.note ?? null,
          achievementRefType: input.achievementRefType ?? null,
          achievementRefId: input.achievementRefId ?? null,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await publishCommunityEvent(tx, {
      eventType: "KudosGiven",
      aggregateType: "Kudos",
      aggregateId: kudosId,
      payload: {
        kudosId,
        fromPersonId: input.caller.id,
        toPersonId: input.toPersonId,
        achievementRefType: input.achievementRefType ?? null,
        achievementRefId: input.achievementRefId ?? null,
      },
    });

    await recordAuditEvent(tx.communityDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "kudos.give",
      resourceType: "kudos",
      resourceId: kudosId,
      metadata: { toPersonId: input.toPersonId },
    });
  });

  return { kudosId };
}
