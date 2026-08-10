import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can } from "@volunteer-portal/authz";
import { ForbiddenActionError, RoleAssignmentNotFoundError } from "../domain/errors";
import { getCallerPolicySubject } from "./getCallerPolicySubject";
import { listActiveRoleAssignments } from "./listActiveRoleAssignments";

/**
 * RevokeRole (docs/ddd/identity-access.md, Key Use Case 3).
 *
 * *Pre:* An active `RoleAssignment` matching the target exists; caller
 * passes the same scoped `can()` check as granting.
 *
 * *Post:* The row's `revokedBy`/`revokedAt` are set (no delete);
 * `RoleRevoked` is emitted; `recordAuditEvent()` tags the outbox write
 * `audit: true`.
 */
export interface RevokeRoleInput {
  callerId: string;
  roleAssignmentId: string;
}

export async function revokeRole(prisma: PrismaClient, input: RevokeRoleInput): Promise<void> {
  const target = await prisma.roleAssignment.findUnique({
    where: { id: input.roleAssignmentId },
    select: { id: true, subjectId: true, role: true, scopeType: true, scopeId: true, revokedAt: true },
  });
  if (!target || target.revokedAt !== null) {
    throw new RoleAssignmentNotFoundError(input.roleAssignmentId);
  }

  const [callerSubject, callerAssignments] = await Promise.all([
    getCallerPolicySubject(prisma, input.callerId, "role.revoke"),
    listActiveRoleAssignments(prisma, input.callerId),
  ]);
  const allowed = can(
    callerSubject,
    "role.revoke",
    { type: "role_assignment", scopeType: target.scopeType, scopeId: target.scopeId, role: target.role },
    callerAssignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("role.revoke");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.roleAssignment.update({
        where: { id: input.roleAssignmentId, revokedAt: null },
        data: { revokedBy: input.callerId, revokedAt: new Date() },
        select: { id: true, subjectId: true, role: true, scopeType: true, scopeId: true, revokedBy: true, revokedAt: true },
      });

      await tx.identityDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "RoleAssignment",
          aggregateId: revoked.id,
          eventType: "RoleRevoked",
          payload: {
            roleAssignmentId: revoked.id,
            subjectId: revoked.subjectId,
            role: revoked.role,
            scopeType: revoked.scopeType,
            scopeId: revoked.scopeId,
            revokedBy: revoked.revokedBy,
            revokedAt: revoked.revokedAt!.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: input.callerId,
        actorType: "user",
        action: "role.revoke",
        resourceType: "role_assignment",
        resourceId: revoked.id,
        scopeType: target.scopeType === "global" ? "global" : "chapter",
        scopeId: target.scopeId ?? undefined,
        metadata: { targetPersonId: revoked.subjectId, role: revoked.role, scopeType: target.scopeType },
      });
    });
  } catch (error) {
    // The row was revoked by a concurrent request between our read above
    // and this update (`WHERE revokedAt IS NULL` matched nothing) —
    // surface the same "not found/already revoked" error as the
    // pre-check, rather than a raw Prisma "record not found".
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new RoleAssignmentNotFoundError(input.roleAssignmentId);
    }
    throw error;
  }
}
