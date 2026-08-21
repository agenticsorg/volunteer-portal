import type { PrismaClient } from "@prisma/client";
import { hasCompletedRequiredCourses } from "@/modules/training";

/**
 * `hasCompletedRequiredTraining` — the cross-context check DecideApplication
 * invariant 5 requires before accepting an Application: "the applicant
 * satisfies the parent Opportunity's `prerequisiteCourseIds`, verified via
 * Training's `hasCompletedRequiredTraining` query at decision time."
 *
 * *** Phase 4 replacement (was a Phase 3 stub that always returned `true`).
 * *** Per docs/plans/implementation-plan.md's Phase 4 prompt (build item
 * 6): "replace the stubbed `hasCompletedRequiredTraining` check with a
 * real call to this context's published query function that checks a
 * person's completed courses against an Opportunity's
 * `prerequisiteCourseIds`." Delegates to `training`'s own Open Host
 * Service query export (`hasCompletedRequiredCourses`, imported only
 * through `@/modules/training`'s `index.ts` barrel — never a direct
 * cross-schema read of `training.*` tables), the same by-ID,
 * OHS-query-only pattern this module already follows for `identity`
 * (`getPersonSummary`, `listActiveRoleAssignments`).
 *
 * Vacuously `true` when `prerequisiteCourseIds` is empty — an Opportunity
 * with no prerequisites never blocks anyone, same behavior the stub it
 * replaces already documented (and `hasCompletedRequiredCourses` itself
 * preserves).
 */
export async function hasCompletedRequiredTraining(
  prisma: PrismaClient,
  applicantPersonId: string,
  prerequisiteCourseIds: readonly string[],
): Promise<boolean> {
  return hasCompletedRequiredCourses(prisma, applicantPersonId, prerequisiteCourseIds);
}
