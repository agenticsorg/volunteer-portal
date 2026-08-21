import type { PrismaClient } from "@prisma/client";
import { can, type Action, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

/**
 * Every content-authoring `can()`-gated action in this module
 * (`course.manage`, `video.captions.approve`) resolves to the same
 * `scopeType: "global"` resource — `Course`/`Module`/`Video` carry no
 * chapter scope of their own (docs/ddd/training-learning.md's Course
 * aggregate is org-wide), unlike `volunteering`'s chapter-scoped
 * resources. Fetches `caller`'s active role assignments from `identity`'s
 * exported `listActiveRoleAssignments` (the sanctioned cross-module read
 * for role data — see `modules/volunteering/application/
 * assertVolunteeringAuthority.ts` for the established precedent this
 * mirrors) and runs `can()` (ADR-0007), throwing `ForbiddenActionError` on
 * denial.
 */
export async function assertTrainingAuthority(
  prisma: PrismaClient,
  caller: PolicySubject,
  action: Action,
): Promise<void> {
  const assignments = await listActiveRoleAssignments(prisma, caller.id);
  const allowed = can(caller, action, { type: "course", scopeType: "global", scopeId: null }, assignments);
  if (!allowed) {
    throw new ForbiddenActionError(action);
  }
}
