import { describe, expect, it } from "vitest";
import { STREAK_MILESTONE_LENGTHS, isMilestoneStreakLength } from "@/modules/community";

// Pure-function coverage for `HandleStreakExtended`'s milestone filter
// (docs/ddd/community-social.md, Integration & Anti-Corruption Notes: "only
// milestone streak lengths (7, 30, 100 days, ...) produce a `FeedEntry`") —
// no database, per ADR-0015's unit/integration split.
describe("isMilestoneStreakLength", () => {
  it("is true for exactly the documented milestone lengths", () => {
    expect(STREAK_MILESTONE_LENGTHS).toEqual([7, 30, 100]);
    for (const length of STREAK_MILESTONE_LENGTHS) {
      expect(isMilestoneStreakLength(length)).toBe(true);
    }
  });

  it("is false for every non-milestone length, including the day before/after a milestone", () => {
    expect(isMilestoneStreakLength(1)).toBe(false);
    expect(isMilestoneStreakLength(6)).toBe(false);
    expect(isMilestoneStreakLength(8)).toBe(false);
    expect(isMilestoneStreakLength(29)).toBe(false);
    expect(isMilestoneStreakLength(31)).toBe(false);
    expect(isMilestoneStreakLength(99)).toBe(false);
    expect(isMilestoneStreakLength(101)).toBe(false);
  });

  it("is false at zero and never negative-length-sensitive in a surprising way", () => {
    expect(isMilestoneStreakLength(0)).toBe(false);
    expect(isMilestoneStreakLength(-7)).toBe(false);
  });
});
