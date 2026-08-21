import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { TeamNameTakenError } from "../domain/errors";
import { publishCommunityEvent } from "./publishCommunityEvent";

export interface CreateTeamInput {
  caller: PolicySubject;
  chapterId: string;
  name: string;
  description?: string;
}

export interface CreatedTeam {
  teamId: string;
}

/**
 * CreateTeam (docs/ddd/community-social.md, Key Use Case 3). Validates
 * Team invariant 1 (`(chapterId, name)` unique among `active` Teams —
 * checked explicitly here, not left to the DB unique index alone, per the
 * doc's own "validates ... uniqueness" framing for this use case), creates
 * the Team, opens the creator's own `TeamMembership(role = 'lead')`
 * (satisfying Team invariant 3's "must retain at least one open `lead`
 * membership" from the moment the Team exists), and emits `TeamCreated`.
 */
export async function createTeam(prisma: PrismaClient, input: CreateTeamInput): Promise<CreatedTeam> {
  const existing = await prisma.team.findFirst({
    where: { chapterId: input.chapterId, name: input.name, status: "active" },
    select: { id: true },
  });
  if (existing) {
    throw new TeamNameTakenError(input.chapterId, input.name);
  }

  const teamId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.team.create({
      data: {
        id: teamId,
        chapterId: input.chapterId,
        name: input.name,
        description: input.description ?? "",
        createdByPersonId: input.caller.id,
      },
    });

    await tx.teamMembership.create({
      data: {
        id: newId(),
        teamId,
        personId: input.caller.id,
        role: "lead",
      },
    });

    await publishCommunityEvent(tx, {
      eventType: "TeamCreated",
      aggregateType: "Team",
      aggregateId: teamId,
      payload: { teamId, chapterId: input.chapterId, createdByPersonId: input.caller.id },
    });

    await recordAuditEvent(tx.communityDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "team.create",
      resourceType: "team",
      resourceId: teamId,
      scopeType: "chapter",
      scopeId: input.chapterId,
      metadata: { name: input.name },
    });
  });

  return { teamId };
}
