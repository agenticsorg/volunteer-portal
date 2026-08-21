import { describe, expect, it } from "vitest";
import { applyStreakActivity, initialStreakState, MAX_FREEZES, type StreakState } from "@/modules/gamification";

// Pure-function coverage for the Streak forgiveness/grace state machine
// (docs/ddd/gamification.md, Streak invariants 1-3) — no database, per
// ADR-0015's unit/integration split.

const MONDAY_WEEK_1 = new Date("2026-01-05T10:00:00.000Z"); // a Monday
const MONDAY_WEEK_2 = new Date("2026-01-12T10:00:00.000Z");
const FRIDAY_WEEK_2 = new Date("2026-01-16T09:00:00.000Z"); // same ISO week as MONDAY_WEEK_2
const MONDAY_WEEK_4 = new Date("2026-01-26T10:00:00.000Z"); // week 3 skipped entirely (2 ISO weeks after week 2's Monday)

describe("applyStreakActivity", () => {
  it("first-ever activity starts a streak at length 1 and publishes 'extended'", () => {
    const outcome = applyStreakActivity(null, MONDAY_WEEK_1);
    expect(outcome.kind).toBe("extended");
    expect(outcome.state.currentLength).toBe(1);
    expect(outcome.state.longestLength).toBe(1);
    expect(outcome.state.status).toBe("active");
    expect(outcome.state.freezesAvailable).toBe(MAX_FREEZES);
  });

  it("a second activity in the same cadence window is a no-op ('unchanged')", () => {
    const week2 = applyStreakActivity(null, MONDAY_WEEK_2);
    expect(week2.kind).toBe("extended");

    const sameWeekAgain = applyStreakActivity(week2.state, FRIDAY_WEEK_2);
    expect(sameWeekAgain.kind).toBe("unchanged");
    expect(sameWeekAgain.state.currentLength).toBe(1);
  });

  it("the next cadence window extends the streak by one, without consuming a freeze", () => {
    const week1 = applyStreakActivity(null, MONDAY_WEEK_1);
    const week2 = applyStreakActivity(week1.state, MONDAY_WEEK_2);
    expect(week2.kind).toBe("extended");
    expect(week2.state.currentLength).toBe(2);
    expect(week2.state.longestLength).toBe(2);
    expect(week2.state.freezesAvailable).toBe(MAX_FREEZES);
    expect(week2.state.status).toBe("active");
  });

  it("a missed window is forgiven by a freeze when one is available — currentLength preserved, not incremented", () => {
    const week1 = applyStreakActivity(null, MONDAY_WEEK_1);
    const week2 = applyStreakActivity(week1.state, MONDAY_WEEK_2); // currentLength=2
    // Week 3 is skipped entirely; the next activity lands in week 4.
    const frozen = applyStreakActivity(week2.state, MONDAY_WEEK_4);

    expect(frozen.kind).toBe("frozen");
    expect(frozen.state.status).toBe("frozen");
    expect(frozen.state.currentLength).toBe(2); // preserved, not incremented and not reset
    expect(frozen.state.freezesAvailable).toBe(MAX_FREEZES - 1);
    expect(frozen.state.freezesUsedTotal).toBe(1);
  });

  it("status returns to 'active' on the next successful extension after a freeze", () => {
    const week1 = applyStreakActivity(null, MONDAY_WEEK_1);
    const week2 = applyStreakActivity(week1.state, MONDAY_WEEK_2);
    const frozen = applyStreakActivity(week2.state, MONDAY_WEEK_4); // status: frozen, length preserved at 2

    const nextWeek = new Date(MONDAY_WEEK_4.getTime() + 7 * 24 * 60 * 60 * 1000);
    const resumed = applyStreakActivity(frozen.state, nextWeek);

    expect(resumed.kind).toBe("extended");
    expect(resumed.state.status).toBe("active");
    expect(resumed.state.currentLength).toBe(3); // 2 (preserved) + 1
  });

  it("a missed window with no freezes available breaks the streak — currentLength resets, longestLength preserved", () => {
    let state: StreakState = initialStreakState(0); // no freezes available
    state = applyStreakActivity(state, MONDAY_WEEK_1).state;
    state = applyStreakActivity(state, MONDAY_WEEK_2).state; // currentLength=2, longestLength=2

    const broken = applyStreakActivity(state, MONDAY_WEEK_4);
    expect(broken.kind).toBe("broken");
    expect(broken.state.status).toBe("broken");
    expect(broken.state.currentLength).toBe(0);
    expect(broken.state.longestLength).toBe(2); // preserved
  });

  it("freezesAvailable never exceeds the configured cap (invariant 3)", () => {
    const state = initialStreakState(MAX_FREEZES);
    expect(state.freezesAvailable).toBeLessThanOrEqual(MAX_FREEZES);
  });

  it("does not regress state for an out-of-order/backdated activity", () => {
    const week2 = applyStreakActivity(null, MONDAY_WEEK_2);
    const backdated = applyStreakActivity(week2.state, MONDAY_WEEK_1); // earlier than lastActivityDate
    expect(backdated.kind).toBe("unchanged");
    expect(backdated.state).toEqual(week2.state);
  });
});
