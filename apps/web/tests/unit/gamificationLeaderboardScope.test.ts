import { describe, expect, it } from "vitest";
import { assertScopedLeaderboard, computeHoursApprovedPoints, POINTS_PER_HOUR } from "@/modules/gamification";

// Pure-function coverage for the leaderboard scope guard
// (docs/ddd/gamification.md, Leaderboard invariant: "never global") and the
// points-per-hour computation — no database, per ADR-0015's unit/
// integration split.

describe("assertScopedLeaderboard", () => {
  it("accepts a valid 'team' scope", () => {
    expect(() => assertScopedLeaderboard({ scopeType: "team", scopeId: "team_1" })).not.toThrow();
  });

  it("accepts a valid 'challenge' scope", () => {
    expect(() => assertScopedLeaderboard({ scopeType: "challenge", scopeId: "challenge_1" })).not.toThrow();
  });

  it("rejects 'global' — the platform-wide scope this context refuses to support, even bypassing the type system", () => {
    expect(() => assertScopedLeaderboard({ scopeType: "global", scopeId: "anything" })).toThrow(
      /never|global|team.*challenge/i,
    );
  });

  it("rejects an empty scopeId even for an otherwise-valid scopeType", () => {
    expect(() => assertScopedLeaderboard({ scopeType: "team", scopeId: "" })).toThrow();
  });

  it("rejects an arbitrary unrecognized scopeType", () => {
    expect(() => assertScopedLeaderboard({ scopeType: "platform", scopeId: "x" })).toThrow();
  });
});

describe("computeHoursApprovedPoints", () => {
  it(`awards ${POINTS_PER_HOUR} points per full hour`, () => {
    expect(computeHoursApprovedPoints(60)).toBe(POINTS_PER_HOUR);
    expect(computeHoursApprovedPoints(120)).toBe(POINTS_PER_HOUR * 2);
  });

  it("prorates partial hours, rounded to the nearest whole point", () => {
    expect(computeHoursApprovedPoints(30)).toBe(5); // half an hour -> 5 points
    expect(computeHoursApprovedPoints(90)).toBe(15); // 1.5 hours -> 15 points
  });
});
