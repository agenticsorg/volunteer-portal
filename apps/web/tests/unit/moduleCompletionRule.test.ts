import { describe, expect, it } from "vitest";
import { isModuleReadyToComplete, isCourseReadyToComplete } from "@/modules/training";

// Pure predicate logic for the module- and course-completion invariants
// (docs/ddd/training-learning.md, Module invariant 1: "watch progress >=
// 90% AND any attached quiz passed"; Enrollment invariant 3: "every
// required module completed") — no database, per ADR-0015's unit/
// integration split. `moduleCompletion.ts` (application layer) calls these
// after loading the relevant rows inside its transaction. The full,
// DB-backed end-to-end proof (watch-progress + quiz gating, certificate
// issuance, CourseCompleted) lives in trainingLifecycle.integration.test.ts;
// this file isolates the decision logic itself.
describe("isModuleReadyToComplete", () => {
  it("below 90% watch progress never completes, even with a passed quiz", () => {
    expect(isModuleReadyToComplete(89, true)).toBe(false);
    expect(isModuleReadyToComplete(0, true)).toBe(false);
  });

  it("90% is the inclusive threshold", () => {
    expect(isModuleReadyToComplete(90, true)).toBe(true);
    expect(isModuleReadyToComplete(89.99, true)).toBe(false);
  });

  it(">= 90% watch progress alone does not complete a module whose quiz is unpassed", () => {
    expect(isModuleReadyToComplete(100, false)).toBe(false);
  });

  it("completes once both watch progress >= 90% and the quiz is passed", () => {
    expect(isModuleReadyToComplete(95, true)).toBe(true);
  });

  it("a module with no quiz (quizPassed vacuously true) completes on watch progress alone", () => {
    expect(isModuleReadyToComplete(100, true)).toBe(true);
  });
});

describe("isCourseReadyToComplete", () => {
  it("a course with zero required modules never auto-completes this way", () => {
    expect(isCourseReadyToComplete(0, 0)).toBe(false);
  });

  it("is not complete while any required module is still incomplete", () => {
    expect(isCourseReadyToComplete(3, 2)).toBe(false);
  });

  it("completes once every required module is completed", () => {
    expect(isCourseReadyToComplete(3, 3)).toBe(true);
  });

  it("a single required module completing a single-module course", () => {
    expect(isCourseReadyToComplete(1, 1)).toBe(true);
  });
});
