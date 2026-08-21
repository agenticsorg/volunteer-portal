import type { PrismaClient } from "@prisma/client";
import { can, type Action, type PolicySubject, type ScopeType } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

/**
 * Every `can()`-gated action in this module resolves to a `Resource` scoped
 * by chapter — a `null` `chapterId` (an org-wide Opportunity) maps to
 * `scopeType: "global"`, matching `@volunteer-portal/authz`'s
 * `hasChapterManagementAuthority`/`hasApprovalAuthority` rules (only
 * `org_admin` can act on a `"global"`-scoped resource, since a
 * `chapter_lead`/`mentor` assignment is always chapter- or org-scoped, never
 * "the org-wide bucket").
 */
function chapterResource(resourceType: string, chapterId: string | null): {
  type: string;
  scopeType: ScopeType;
  scopeId: string | null;
} {
  return chapterId === null
    ? { type: resourceType, scopeType: "global", scopeId: null }
    : { type: resourceType, scopeType: "chapter", scopeId: chapterId };
}

/**
 * Fetches `caller`'s active role assignments from `identity`'s exported
 * `listActiveRoleAssignments` (the sanctioned cross-module read for role
 * data, same as `getPersonSummary` is for display data — see this module's
 * `index.ts` and ADR-0001) and runs `can()` (ADR-0007), throwing
 * `ForbiddenActionError` on denial. `caller.status` must already be
 * resolved by the caller (this module never queries `identity.persons`
 * directly) — see the doc comment on `PolicySubject` in
 * `packages/authz/src/types.ts` for why that field is required, not
 * optional.
 */
export async function assertVolunteeringAuthority(
  prisma: PrismaClient,
  caller: PolicySubject,
  action: Action,
  resourceType: string,
  chapterId: string | null,
): Promise<void> {
  const assignments = await listActiveRoleAssignments(prisma, caller.id);
  const allowed = can(caller, action, chapterResource(resourceType, chapterId), assignments);
  if (!allowed) {
    throw new ForbiddenActionError(action);
  }
}
