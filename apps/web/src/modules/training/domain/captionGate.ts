/**
 * Pure predicate logic for PublishCourse's mandatory caption-approval gate
 * (docs/ddd/training-learning.md, Course invariant 3; ADR-0010's explicit
 * rejection of unlisted-YouTube-style "publish now, caption later"
 * approaches). No Prisma/database dependency — takes the already-loaded
 * module/video shape, so it's unit-testable in isolation. `publishCourse.ts`
 * (application layer) is the only call site; there is no other code path
 * that publishes a course.
 */

/** The minimal shape PublishCourse needs from each Module + its Video to evaluate the gate. */
export interface ModuleCaptionState {
  id: string;
  video: { captionStatus: string } | null;
}

/**
 * True iff every module in the course has a video whose captions are
 * `approved`, and the course has at least one module. A course with zero
 * modules is never publishable (there is nothing to gate, but also nothing
 * to publish).
 */
export function isCoursePublishable(modules: readonly ModuleCaptionState[]): boolean {
  return modules.length > 0 && modules.every((m) => m.video?.captionStatus === "approved");
}

/**
 * The first module (in array order) blocking publication — either it has
 * no Video at all, or its Video's captions are not yet `approved`. Returns
 * `null` when the course is publishable. Used to build the
 * `CourseNotPublishableError` message.
 */
export function findCaptionGateBlocker(modules: readonly ModuleCaptionState[]): ModuleCaptionState | null {
  return modules.find((m) => m.video?.captionStatus !== "approved") ?? null;
}
