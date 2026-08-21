import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ModerationActionNotActiveError, ModerationActionNotFoundError, OutOfScopeError } from "../domain/errors";
import { publishModerationEvent } from "./publishModerationEvent";

export interface RevokeModerationActionInput {
  caller: PolicySubject;
  actionId: string;
  revokeReason: string;
}

export interface RevokedModerationAction {
  status: "revoked";
}

/**
 * RevokeModerationAction (docs/ddd/moderation-trust-safety.md, Key Use
 * Case 7). Validates the caller is the issuing moderator or an
 * `org_admin` (`moderation_action.revoke`, ADR-0007), transitions
 * `active -> revoked`, records `revokedByPersonId`/`revokeReason` (never
 * a silent row deletion — ModerationAction invariant 4), emits
 * `ModerationActionRevoked`.
 */
export async function revokeModerationAction(
  prisma: PrismaClient,
  input: RevokeModerationActionInput,
): Promise<RevokedModerationAction> {
  const action = await prisma.moderationAction.findUnique({ where: { id: input.actionId } });
  if (!action) {
    throw new ModerationActionNotFoundError(input.actionId);
  }
  if (action.status !== "active") {
    throw new ModerationActionNotActiveError(input.actionId, action.status);
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "moderation_action.revoke",
    { type: "moderation_action", scopeType: "global", scopeId: null, ownerId: action.moderatorPersonId },
    assignments,
  );
  if (!allowed) {
    throw new OutOfScopeError("moderation_action.revoke");
  }

  await prisma.$transaction(async (tx) => {
    await tx.moderationAction.update({
      where: { id: input.actionId },
      data: {
        status: "revoked",
        revokedByPersonId: input.caller.id,
        revokedAt: new Date(),
        revokeReason: input.revokeReason,
      },
    });

    await publishModerationEvent(tx, {
      eventType: "ModerationActionRevoked",
      aggregateType: "ModerationAction",
      aggregateId: input.actionId,
      payload: { actionId: input.actionId, revokedByPersonId: input.caller.id, revokeReason: input.revokeReason },
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "moderation.action_revoked",
      resourceType: "moderation_action",
      resourceId: input.actionId,
      metadata: { revokeReason: input.revokeReason },
    });
  });

  return { status: "revoked" };
}
