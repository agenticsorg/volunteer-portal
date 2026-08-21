import { describe, expect, it } from "vitest";
import { isCriteriaSatisfied, parseBadgeCriteria, type BadgeEvaluationContext } from "@/modules/gamification";

// Pure-function coverage for Badge.criteria parsing/evaluation
// (docs/ddd/gamification.md, "Badge" aggregate / EvaluateBadgeCriteria) —
// no database, per ADR-0015's unit/integration split.

const baseCtx: BadgeEvaluationContext = { personId: "person_1", sourceEventId: "event_1" };

describe("parseBadgeCriteria", () => {
  it("parses a well-formed course_completed criteria", () => {
    expect(parseBadgeCriteria({ type: "course_completed", courseId: "course_1" })).toEqual({
      type: "course_completed",
      courseId: "course_1",
    });
  });

  it("returns null for an unrecognized type", () => {
    expect(parseBadgeCriteria({ type: "not_a_real_type" })).toBeNull();
  });

  it("returns null for a malformed shape (missing required field)", () => {
    expect(parseBadgeCriteria({ type: "streak_length", activityType: "shift_cadence" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseBadgeCriteria("not an object")).toBeNull();
    expect(parseBadgeCriteria(null)).toBeNull();
  });
});

describe("isCriteriaSatisfied", () => {
  it("course_completed: satisfied only when the triggering event completed exactly that course", () => {
    const criteria = { type: "course_completed", courseId: "course_1" } as const;
    expect(isCriteriaSatisfied(criteria, { ...baseCtx, courseCompletedId: "course_1" })).toBe(true);
    expect(isCriteriaSatisfied(criteria, { ...baseCtx, courseCompletedId: "course_2" })).toBe(false);
    expect(isCriteriaSatisfied(criteria, baseCtx)).toBe(false);
  });

  it("streak_length: satisfied once currentLength reaches the threshold for the matching activityType", () => {
    const criteria = { type: "streak_length", activityType: "shift_cadence", length: 8 } as const;
    expect(
      isCriteriaSatisfied(criteria, { ...baseCtx, streak: { activityType: "shift_cadence", currentLength: 8 } }),
    ).toBe(true);
    expect(
      isCriteriaSatisfied(criteria, { ...baseCtx, streak: { activityType: "shift_cadence", currentLength: 7 } }),
    ).toBe(false);
    // A different activityType's streak must not satisfy this criteria, even at a qualifying length.
    expect(
      isCriteriaSatisfied(criteria, { ...baseCtx, streak: { activityType: "training_cadence", currentLength: 8 } }),
    ).toBe(false);
  });

  it("points_total: satisfied once totalPoints reaches the threshold", () => {
    const criteria = { type: "points_total", threshold: 100 } as const;
    expect(isCriteriaSatisfied(criteria, { ...baseCtx, totalPoints: 100 })).toBe(true);
    expect(isCriteriaSatisfied(criteria, { ...baseCtx, totalPoints: BigInt(150) })).toBe(true);
    expect(isCriteriaSatisfied(criteria, { ...baseCtx, totalPoints: 99 })).toBe(false);
    expect(isCriteriaSatisfied(criteria, baseCtx)).toBe(false);
  });
});
