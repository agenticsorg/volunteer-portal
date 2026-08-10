import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type Role, type ScopeType } from "@volunteer-portal/authz";
import { ForbiddenActionError, InvalidRoleScopeError } from "../domain/errors";
import { listActiveRoleAssignments, type RoleAssignmentRecord } from "./listActiveRoleAssignments";

/**
 * GrantRole (docs/ddd/identity-access.md, Key Use Case 2).
 *
 * *Pre:* `can(caller, 'role.grant', {role, scopeType, scopeId})` (an
 * `org_admin` may grant any role at any scope; a `chapter_lead` may only
 * grant `mentor`/`volunteer` scoped to their own chapter); no active
 * assignment already exists for the target
 * `(subjectId, role, scopeType, scopeId)`.
 *
 * *Post:* A new active `RoleAssignment` row exists; `RoleGranted` is
 * emitted; `recordAuditEvent()` tags the outbox write `audit: true`
 * (`action = 'role.grant'`, `target_person_id = subjectId`).
 */
export interface GrantRoleInput {
  callerId: string;
  subjectId: string;
  role: Role;
  scopeType: ScopeType;
  scopeId: string | null;
}

export interface GrantedRole {
  roleAssignmentId: string;
  /** True when an already-active assignment for this exact tuple was
   * found and reused instead of creating a duplicate row (RoleAssignment
   * invariant 2: "re-granting an already-active role is a no-op, not a
   * duplicate row"). */
  alreadyActive: boolean;
}

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function assertValidScope(scopeType: ScopeType, scopeId: string | null): void {
  const scopeIdRequired = scopeType !== "global";
  if (scopeIdRequired !== (scopeId !== null)) {
    throw new InvalidRoleScopeError();
  }
}

export async function grantRole(prisma: PrismaClient, input: GrantRoleInput): Promise<GrantedRole> {
  assertValidScope(input.scopeType, input.scopeId);

  const callerAssignments = await listActiveRoleAssignments(prisma, input.callerId);
  const allowed = can(
    { id: input.callerId },
    "role.grant",
    { type: "role_assignment", scopeType: input.scopeType, scopeId: input.scopeId, role: input.role },
    callerAssignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("role.grant");
  }

  const existing = await findActiveAssignment(prisma, input);
  if (existing) {
    return { roleAssignmentId: existing.id, alreadyActive: true };
  }

  const roleAssignmentId = newId();
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.roleAssignment.create({
        data: {
          id: roleAssignmentId,
          subjectId: input.subjectId,
          role: input.role,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          grantedBy: input.callerId,
        },
        select: { id: true, subjectId: true, role: true, scopeType: true, scopeId: true, grantedBy: true, grantedAt: true },
      });

      await tx.identityDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "RoleAssignment",
          aggregateId: created.id,
          eventType: "RoleGranted",
          payload: {
            roleAssignmentId: created.id,
            subjectId: created.subjectId,
            role: created.role,
            scopeType: created.scopeType,
            scopeId: created.scopeId,
            grantedBy: created.grantedBy,
            grantedAt: created.grantedAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: input.callerId,
        actorType: "user",
        action: "role.grant",
        resourceType: "role_assignment",
        resourceId: created.id,
        // `@volunteer-portal/audit`'s `AuditScopeType` is `"chapter" |
        // "global"` only (mirrors `admin.audit_log.scope_type`'s two
        // documented values, ADR-0014 §4) — a `team`-scoped grant is
        // reported as `"chapter"` here for audit-log purposes; the exact
        // `scopeType`/`scopeId` are preserved in `metadata` below.
        scopeType: input.scopeType === "global" ? "global" : "chapter",
        scopeId: input.scopeId ?? undefined,
        metadata: { targetPersonId: input.subjectId, role: input.role, scopeType: input.scopeType },
      });
    });
  } catch (error) {
    // A concurrent grant of the exact same tuple raced us past the
    // `findActiveAssignment` check above — `uq_role_assignments_active`
    // (the partial unique index, keyed on `COALESCE(scope_id, '')` so a
    // `global`-scoped tuple's NULL `scope_id` collides correctly instead
    // of two NULLs silently coexisting — see the
    // `..._fix_role_assignments_active_null_scope_uniqueness` migration)
    // is the real backstop; treat it the same as the pre-check finding an
    // existing row (RoleAssignment invariant 2).
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const raced = await findActiveAssignment(prisma, input);
      if (raced) {
        return { roleAssignmentId: raced.id, alreadyActive: true };
      }
    }
    throw error;
  }

  return { roleAssignmentId, alreadyActive: false };
}

async function findActiveAssignment(
  prisma: PrismaClient,
  input: GrantRoleInput,
): Promise<RoleAssignmentRecord | null> {
  const active = await listActiveRoleAssignments(prisma, input.subjectId);
  return (
    active.find(
      (a) =>
        a.role === input.role && a.scopeType === input.scopeType && a.scopeId === input.scopeId,
    ) ?? null
  );
}
