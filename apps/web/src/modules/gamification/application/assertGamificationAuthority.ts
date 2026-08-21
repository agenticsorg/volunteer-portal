import type { PrismaClient } from "@prisma/client";
import { can, type Action, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

/**
 * Every `can()`-gated action in this module (`points.adjust`, `badge.award`
 * — both staff-only escape hatches, docs/ddd/gamification.md Key Use Cases
 * 4/9) is an org-wide governance action with no chapter/team scope of its
 * own (a points/badge correction can target any person regardless of
 * chapter), so every resource here is `scopeType: "global"` — same shape as
 * `modules/training/application/assertTrainingAuthority.ts`. Fetches
 * `caller`'s active role assignments from `identity`'s exported
 * `listActiveRoleAssignments` (the sanctioned cross-module read for role
 * data) and runs `can()` (ADR-0007), throwing `ForbiddenActionError` on
 * denial.
 */
export async function assertGamificationAuthority(
  prisma: PrismaClient,
  caller: PolicySubject,
  action: Action,
): Promise<void> {
  const assignments = await listActiveRoleAssignments(prisma, caller.id);
  const allowed = can(caller, action, { type: "gamification", scopeType: "global", scopeId: null }, assignments);
  if (!allowed) {
    throw new ForbiddenActionError(action);
  }
}
