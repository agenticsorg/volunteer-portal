import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { AlreadyTeamMemberError, TeamNotFoundError } from "../domain/errors";
import { publishCommunityEvent } from "./publishCommunityEvent";

export interface JoinTeamInput {
  caller: PolicySubject;
  teamId: string;
}

export interface JoinedTeam {
  teamMembershipId: string;
}

/**
 * JoinTeam (docs/ddd/community-social.md, Key Use Case 4). Validates no
 * existing open membership for `(teamId, personId)` (TeamMembership
 * invariant 2 — re-joining after leaving opens a new row, never reopens an
 * old one), opens a `TeamMembership(role = 'member')`, and emits
 * `TeamJoined`.
 */
export async function joinTeam(prisma: PrismaClient, input: JoinTeamInput): Promise<JoinedTeam> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId }, select: { id: true, chapterId: true } });
  if (!team) {
    throw new TeamNotFoundError(input.teamId);
  }

  const existingOpenMembership = await prisma.teamMembership.findFirst({
    where: { teamId: input.teamId, personId: input.caller.id, leftAt: null },
    select: { id: true },
  });
  if (existingOpenMembership) {
    throw new AlreadyTeamMemberError(input.teamId, input.caller.id);
  }

  const teamMembershipId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.teamMembership.create({
      data: {
        id: teamMembershipId,
        teamId: input.teamId,
        personId: input.caller.id,
        role: "member",
      },
    });

    await publishCommunityEvent(tx, {
      eventType: "TeamJoined",
      aggregateType: "TeamMembership",
      aggregateId: teamMembershipId,
      payload: { teamId: input.teamId, personId: input.caller.id, role: "member" },
    });

    await recordAuditEvent(tx.communityDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "team.join",
      resourceType: "team_membership",
      resourceId: teamMembershipId,
      scopeType: "chapter",
      scopeId: team.chapterId,
      metadata: { teamId: input.teamId },
    });
  });

  return { teamMembershipId };
}
