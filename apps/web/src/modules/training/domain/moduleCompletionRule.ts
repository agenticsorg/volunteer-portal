/**
 * Pure predicate logic for the module- and course-completion invariants
 * (docs/ddd/training-learning.md, Module invariant 1 and Enrollment
 * invariant 3). No Prisma/database dependency — `application/
 * moduleCompletion.ts` (which does the actual reads/writes inside a
 * transaction) calls these after loading the relevant rows, so the
 * decision logic itself is unit-testable in isolation.
 */

/**
 * Module invariant 1: a Module counts as complete only once its watch
 * progress is >= 90% AND, if it has an attached Quiz, that Quiz has been
 * passed at least once (`quizPassed` is `true` when there is no quiz —
 * vacuously satisfied).
 */
export function isModuleReadyToComplete(watchProgressPercent: number, quizPassed: boolean): boolean {
  return watchProgressPercent >= 90 && quizPassed;
}

/**
 * Enrollment invariant 3: an Enrollment's Course counts as complete only
 * once every `isRequired = true` Module is complete. A course with zero
 * required modules never auto-completes this way (there is nothing whose
 * completion could trigger it).
 */
export function isCourseReadyToComplete(requiredModuleCount: number, completedRequiredModuleCount: number): boolean {
  return requiredModuleCount > 0 && completedRequiredModuleCount >= requiredModuleCount;
}
