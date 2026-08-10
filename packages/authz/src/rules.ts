/**
 * @volunteer-portal/authz — the policy rule table (ADR-0007).
 *
 * One `PolicyRule` per `Action`, enforced exhaustively (see `can.ts` and
 * `tests/unit/authz.test.ts`'s CI exhaustiveness check — ADR-0007's
 * Implementation Notes: "a test iterates every value of the `Action`
 * union type and asserts a matching entry exists in `rules`, failing the
 * build if a new action was added without a policy rule").
 */
import type { Action, PolicySubject, Resource, Role, RoleAssignmentFact, ScopeType } from "./types";

/**
 * True iff `assignments` contains an *active* (`revokedAt === null`) row
 * for exactly this `(role, scopeType, scopeId)` tuple. `global`-scoped
 * checks ignore `scopeId` (it is always `null` for a global assignment —
 * `identity.role_assignments`' `chk_role_assignments_scope` CHECK).
 */
export function hasRoleInScope(
  assignments: readonly RoleAssignmentFact[],
  role: Role,
  scopeType: ScopeType,
  scopeId: string | null,
): boolean {
  return assignments.some(
    (a) =>
      a.role === role &&
      a.revokedAt === null &&
      a.scopeType === scopeType &&
      (scopeType === "global" || a.scopeId === scopeId),
  );
}

function isOrgAdmin(assignments: readonly RoleAssignmentFact[]): boolean {
  return hasRoleInScope(assignments, "org_admin", "global", null);
}

/**
 * Roles a `chapter_lead` may grant/revoke within their own chapter
 * (identity-access.md, `RoleAssignment` invariant 4: "a `chapter_lead`
 * may only grant/revoke `mentor`/`volunteer` scoped to their own
 * chapter"). Team-scoped delegation ("assign `team` sub-scope leads",
 * ADR-0007's role table) is deferred — the `community`/team module this
 * would validate against doesn't exist yet in this phase, so team-scoped
 * `role.grant`/`role.revoke` requires `org_admin` for now, same as every
 * other action this table doesn't explicitly delegate.
 */
const CHAPTER_LEAD_DELEGABLE_ROLES: readonly Role[] = ["mentor", "volunteer"];

function chapterLeadMayGrantOrRevoke(
  resource: Resource,
  assignments: readonly RoleAssignmentFact[],
): boolean {
  return (
    resource.scopeType === "chapter" &&
    resource.role !== undefined &&
    CHAPTER_LEAD_DELEGABLE_ROLES.includes(resource.role) &&
    hasRoleInScope(assignments, "chapter_lead", "chapter", resource.scopeId)
  );
}

interface PolicyRule {
  action: Action;
  allow: (
    subject: PolicySubject,
    resource: Resource,
    assignments: readonly RoleAssignmentFact[],
  ) => boolean;
}

export const rules: readonly PolicyRule[] = [
  {
    // GrantRole precondition (identity-access.md Key Use Case 2): an
    // `org_admin` may grant any role at any scope; a `chapter_lead` may
    // only grant `mentor`/`volunteer` scoped to their own chapter.
    action: "role.grant",
    allow: (_subject, resource, assignments) =>
      isOrgAdmin(assignments) || chapterLeadMayGrantOrRevoke(resource, assignments),
  },
  {
    // RevokeRole precondition (Key Use Case 3): "the same scoped `can()`
    // check as granting."
    action: "role.revoke",
    allow: (_subject, resource, assignments) =>
      isOrgAdmin(assignments) || chapterLeadMayGrantOrRevoke(resource, assignments),
  },
  {
    // CreateChapter precondition (Key Use Case 8): "Caller has `org_admin`
    // (global)."
    action: "chapter.create",
    allow: (_subject, _resource, assignments) => isOrgAdmin(assignments),
  },
  {
    // AssignChapterLead: reassigning a chapter's leadership pointer is an
    // org-wide governance action (ADR-0007's role table does not delegate
    // it to `chapter_lead`), gated the same as `chapter.create`.
    action: "chapter.assign_lead",
    allow: (_subject, _resource, assignments) => isOrgAdmin(assignments),
  },
  {
    // RequestDataExport (Key Use Case 6): not explicitly `can()`-gated in
    // the doc's own narrative, but the same "self, or org_admin acting on
    // the subject's behalf" shape as erasure below is the correct
    // least-privilege default for a mutation that returns someone's full
    // personal-data bundle.
    action: "dsar.export.request",
    allow: (subject, resource, assignments) =>
      resource.ownerId === subject.id || isOrgAdmin(assignments),
  },
  {
    // RequestErasure/AnonymizePerson precondition (Key Use Case 7 /
    // identity-access-schema-api.md's `dsar.requestErasure` contract):
    // the subject themselves, or an `org_admin` acting on their behalf
    // ("a support-desk erasure request").
    action: "dsar.erasure.request",
    allow: (subject, resource, assignments) =>
      resource.ownerId === subject.id || isOrgAdmin(assignments),
  },
];
