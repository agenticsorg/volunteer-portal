import type { PrismaClient } from "@prisma/client";
import type { RoleAssignmentFact } from "@volunteer-portal/authz";

/**
 * The full shape of an `identity.role_assignments` row this module hands
 * back to callers — a strict superset of `@volunteer-portal/authz`'s
 * `RoleAssignmentFact`, so this same array can be passed directly to
 * `can()` without any mapping step (structural typing).
 */
export interface RoleAssignmentRecord extends RoleAssignmentFact {
  id: string;
  subjectId: string;
  grantedBy: string;
  grantedAt: Date;
  revokedBy: string | null;
}

const ROLE_ASSIGNMENT_SELECT = {
  id: true,
  subjectId: true,
  role: true,
  scopeType: true,
  scopeId: true,
  grantedBy: true,
  grantedAt: true,
  revokedBy: true,
  revokedAt: true,
} as const;

/**
 * Every *active* (`revokedAt IS NULL`) role assignment for a subject —
 * the exact input `can()` needs (ADR-0007: "`getActiveRoleAssignments(subject.id)`
 * cached per-request"), and this module's own `roles.listForSubject`
 * read (identity-access-schema-api.md's contract sketch, "active only, by
 * default").
 *
 * This is the reusable facility ADR-0007's Implementation Notes describe
 * every bounded-context module eventually calling before invoking `can()`
 * — exported through this module's `index.ts` barrel so `identity`'s own
 * use cases and, in later phases, every other module's privileged
 * procedures can fetch the caller's assignments the same way.
 */
export async function listActiveRoleAssignments(
  prisma: PrismaClient,
  subjectId: string,
): Promise<RoleAssignmentRecord[]> {
  return prisma.roleAssignment.findMany({
    where: { subjectId, revokedAt: null },
    select: ROLE_ASSIGNMENT_SELECT,
  });
}

/** Every role assignment (active and revoked) for a subject — the full history. */
export async function listRoleAssignmentHistory(
  prisma: PrismaClient,
  subjectId: string,
): Promise<RoleAssignmentRecord[]> {
  return prisma.roleAssignment.findMany({
    where: { subjectId },
    select: ROLE_ASSIGNMENT_SELECT,
    orderBy: { grantedAt: "desc" },
  });
}
