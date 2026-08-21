import type { PrismaClient } from "@prisma/client";

/**
 * `hasCompletedRequiredCourses` — this context's Open Host Service query
 * for the prerequisite-training check `volunteering`'s `DecideApplication`
 * (Key Use Case 5, invariant 5) depends on. Exported through this module's
 * `index.ts` (ADR-0001: cross-context reads only ever go through the
 * target module's own published query, never a direct read of another
 * schema's tables) — this is the "real call to this context's published
 * query function" the Phase 4 implementation prompt requires replacing
 * `volunteering`'s Phase 3 `hasCompletedRequiredTraining` stub with.
 *
 * True iff `personId` has a `completed` Enrollment for every course in
 * `requiredCourseIds` — vacuously `true` when `requiredCourseIds` is
 * empty (no prerequisites to satisfy), matching the stub's own documented
 * default. A Person may hold more than one `completed` Enrollment for the
 * same course over time (re-issuance after expiry — Certificate invariant
 * 1); only *any* completed Enrollment per required course matters here,
 * not which one or how many.
 */
export async function hasCompletedRequiredCourses(
  prisma: PrismaClient,
  personId: string,
  requiredCourseIds: readonly string[],
): Promise<boolean> {
  if (requiredCourseIds.length === 0) return true;

  const uniqueRequired = [...new Set(requiredCourseIds)];
  const completed = await prisma.enrollment.findMany({
    where: { personId, courseId: { in: uniqueRequired }, status: "completed" },
    select: { courseId: true },
    distinct: ["courseId"],
  });

  const completedCourseIds = new Set(completed.map((e) => e.courseId));
  return uniqueRequired.every((courseId) => completedCourseIds.has(courseId));
}
