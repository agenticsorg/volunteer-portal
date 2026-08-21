/**
 * `hasCompletedRequiredTraining` — the cross-context check DecideApplication
 * invariant 5 requires before accepting an Application: "the applicant
 * satisfies the parent Opportunity's `prerequisiteCourseIds`, verified via
 * Training's `hasCompletedRequiredTraining` query at decision time."
 *
 * STUB for this phase, per the Phase 3 implementation prompt
 * (docs/plans/implementation-plan.md): "STUB this to always return true for
 * now, since the Training context doesn't exist yet." Deliberately always
 * `true` — never `false` — so an Opportunity with a non-empty
 * `prerequisiteCourseIds` never blocks a real applicant while this stub is
 * in place (the alternative, stubbing to `false`, would make every
 * prerequisite-gated Opportunity impossible to accept anyone into, which is
 * a worse default until Training actually exists to answer the question for
 * real).
 *
 * *** Phase 4 (Training & Learning) MUST replace this stub. *** Per
 * docs/plans/implementation-plan.md's Phase 4 prompt (build item 6): "Go
 * back into the Volunteering module (Phase 3) and replace the stubbed
 * `hasCompletedRequiredTraining` check with a real call to this context's
 * published query function that checks a person's completed courses against
 * an Opportunity's `prerequisiteCourseIds`." That replacement call must go
 * through Training's own Open Host Service query export (never a direct
 * cross-schema read of `training.*` tables) — the same by-ID,
 * OHS-query-only pattern this module already follows for `identity`
 * (`getPersonSummary`, `listActiveRoleAssignments`).
 */
export async function hasCompletedRequiredTraining(
  _applicantPersonId: string,
  _prerequisiteCourseIds: readonly string[],
): Promise<boolean> {
  return true;
}
