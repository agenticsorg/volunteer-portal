import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import { AlreadyTeamMemberError, PersonNotFoundError, TeamNotFoundError } from "../domain/errors";
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
 * old one), opens a `TeamMembership(role = 'member')`, creates a native
 * `FeedEntry` (`kind = 'team_joined'`, chapter-scoped to the Team's own
 * `chapterId` — Teams are always chapter-scoped per Team's own doc comment,
 * so unlike Kudos/Mentorship there's no org-scope default to fall back to
 * here), and emits `TeamJoined`.
 */
export async function joinTeam(prisma: PrismaClient, input: JoinTeamInput): Promise<JoinedTeam> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: { id: true, chapterId: true, name: true },
  });
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

  const joiner = await getPersonSummary(prisma, input.caller.id);
  if (!joiner) {
    throw new PersonNotFoundError(input.caller.id);
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

    await tx.feedEntry.create({
      data: {
        id: newId(),
        kind: "team_joined",
        scopeType: "chapter",
        scopeId: team.chapterId,
        subjectPersonId: input.caller.id,
        subjectDisplayName: joiner.displayName,
        sourceType: "community.team_membership",
        sourceId: teamMembershipId,
        sourceEventId: null,
        summary: `${joiner.displayName} joined ${team.name}`,
        payload: { teamId: team.id, teamName: team.name },
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
