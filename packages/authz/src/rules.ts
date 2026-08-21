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
 * True iff the subject holds `org_admin` (global), or `chapter_lead` scoped
 * to exactly `resource.scopeId` (only meaningful when `resource.scopeType
 * === "chapter"` — an org-wide, `chapterId: null` resource, `scopeType:
 * "global"`, can only ever be managed by `org_admin`, matching
 * volunteering-opportunities.md's own framing of chapter-scoped vs.
 * org-wide Opportunities). Shared by every volunteering "manage this
 * Opportunity/Shift" action (`opportunity.create`, `opportunity.manage`,
 * `shift.manage`) — none of these delegate to `mentor`, unlike the
 * approval-authority actions below.
 */
function hasChapterManagementAuthority(
  resource: Resource,
  assignments: readonly RoleAssignmentFact[],
): boolean {
  return (
    isOrgAdmin(assignments) ||
    (resource.scopeType === "chapter" &&
      hasRoleInScope(assignments, "chapter_lead", "chapter", resource.scopeId))
  );
}

/**
 * True iff the subject holds `org_admin` (global), `chapter_lead` scoped to
 * `resource.scopeId`, or `mentor` (either globally, or scoped to
 * `resource.scopeId`) — the exact authority DecideApplication invariant 4
 * and HourEntry invariant 2 both specify ("`chapter_lead`/`mentor` scoped to
 * the Opportunity's chapter, or `org_admin`"). Shared by
 * `application.decide`, `hour_entry.approve`, and `hour_entry.reject`.
 */
function hasApprovalAuthority(
  resource: Resource,
  assignments: readonly RoleAssignmentFact[],
): boolean {
  return (
    hasChapterManagementAuthority(resource, assignments) ||
    hasRoleInScope(assignments, "mentor", "global", null) ||
    (resource.scopeType === "chapter" &&
      hasRoleInScope(assignments, "mentor", "chapter", resource.scopeId))
  );
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

/**
 * True iff the subject holds `org_admin` (global) or `content_admin`
 * (global) — the exact authority ADR-0007's role table gives
 * `content_admin` over "create/edit/publish/unpublish training videos and
 * courses." Shared by every `training` content-authoring action
 * (`course.manage`, `video.captions.approve`) and by `video.play`'s
 * staff-preview branch.
 */
function hasContentAuthority(assignments: readonly RoleAssignmentFact[]): boolean {
  return isOrgAdmin(assignments) || hasRoleInScope(assignments, "content_admin", "global", null);
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
  {
    // CreateOpportunity / PublishOpportunity / (Close/Archive)Opportunity:
    // "caller holds chapter_lead (for the target chapter) or org_admin"
    // (Key Use Case 1's precondition).
    action: "opportunity.create",
    allow: (_subject, resource, assignments) => hasChapterManagementAuthority(resource, assignments),
  },
  {
    action: "opportunity.manage",
    allow: (_subject, resource, assignments) => hasChapterManagementAuthority(resource, assignments),
  },
  {
    // ScheduleShift / CancelShift: same authority as the parent Opportunity.
    action: "shift.manage",
    allow: (_subject, resource, assignments) => hasChapterManagementAuthority(resource, assignments),
  },
  {
    // DecideApplication invariant 4.
    action: "application.decide",
    allow: (_subject, resource, assignments) => hasApprovalAuthority(resource, assignments),
  },
  {
    // HourEntry invariant 2 (approve branch). Self-approval is additionally
    // blocked at the use-case layer (`resource.ownerId === subject.id`
    // check) and by the DB's `chk_hour_entries_no_self_approval` — not
    // repeated here since `can()` has no access to `personId` vs. caller
    // beyond what `Resource`/`PolicySubject` already carry.
    action: "hour_entry.approve",
    allow: (_subject, resource, assignments) => hasApprovalAuthority(resource, assignments),
  },
  {
    // HourEntry invariant 2 (reject branch) — identical authority to approve.
    action: "hour_entry.reject",
    allow: (_subject, resource, assignments) => hasApprovalAuthority(resource, assignments),
  },
  {
    // ExportApprovedHours (Key Use Case 10): "Caller holds org_admin or
    // chapter_lead (scoped to the requested chapter, if any filter is
    // applied)" — identical shape to `opportunity.manage`/`shift.manage`,
    // not `hasApprovalAuthority` (a plain `mentor` may approve individual
    // hour entries but is not granted the bulk grant-report export).
    action: "hours.export",
    allow: (_subject, resource, assignments) => hasChapterManagementAuthority(resource, assignments),
  },
  {
    // CreateCourse / AddModule / InitiateVideoUpload / PublishCourse: see
    // this action's own doc comment in `types.ts`.
    action: "course.manage",
    allow: (_subject, _resource, assignments) => hasContentAuthority(assignments),
  },
  {
    // ApproveCaptions (ADR-0010's mandatory publish gate) — same authority
    // as `course.manage`, its own action for audit-trail granularity.
    action: "video.captions.approve",
    allow: (_subject, _resource, assignments) => hasContentAuthority(assignments),
  },
  {
    // GetPlaybackUrl (ADR-0010): the learner playing their own enrolled
    // video (`resource.ownerId === subject.id`, set by the use case only
    // once it has independently verified an active/completed Enrollment
    // exists — this rule does not and cannot check enrollment itself, it
    // has no DB access), or `content_admin`/`org_admin` previewing any
    // video regardless of enrollment.
    action: "video.play",
    allow: (subject, resource, assignments) =>
      resource.ownerId === subject.id || hasContentAuthority(assignments),
  },
  {
    // AdminAdjustPoints (Key Use Case 9): "staff-only escape hatch" — an
    // org-wide governance action with no chapter delegation, gated the same
    // as `chapter.create`/`chapter.assign_lead`.
    action: "points.adjust",
    allow: (_subject, _resource, assignments) => isOrgAdmin(assignments),
  },
  {
    // adminAwardBadge: same staff-only, org-wide authority as `points.adjust`.
    action: "badge.award",
    allow: (_subject, _resource, assignments) => isOrgAdmin(assignments),
  },
  {
    // CreatePost, Post invariant 1 (docs/ddd/community-social.md): only
    // `org_admin` may create a `scopeType: 'org'` Post — a `chapter_lead`'s
    // authority is scoped to their own chapter and does not extend to
    // posting org-wide, same staff-only shape as `points.adjust`/`badge.award`.
    action: "post.create_org_scope",
    allow: (_subject, _resource, assignments) => isOrgAdmin(assignments),
  },
];
