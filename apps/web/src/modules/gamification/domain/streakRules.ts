/**
 * Streak (docs/ddd/gamification.md, "Streak" aggregate) — the
 * forgiveness/grace state machine. Pure, DB-free: `application/updateStreak.ts`
 * loads the current `gamification.streak` row (or `null` if this is the
 * person's first-ever qualifying activity for this `activityType`), calls
 * `applyStreakActivity`, and persists the returned state.
 *
 * Cadence: every `activityType` this phase feeds (`shift_cadence` from
 * `HoursApproved`, `training_cadence` from `CourseCompleted`) is weekly, per
 * the doc's own example ("the same or next ISO week for shift_cadence").
 * Weeks are compared by their Monday (ISO week start), not by ISO
 * year+week-number arithmetic, so the comparison is correct across a
 * year/ISO-week-53 boundary without needing a full ISO-week-numbering
 * implementation.
 */

export type StreakStatus = "active" | "frozen" | "broken";

/** Cap on `freezesAvailable` (Streak invariant 3) — "e.g. max 2" per the doc. */
export const MAX_FREEZES = 2;

export interface StreakState {
  currentLength: number;
  longestLength: number;
  lastActivityDate: Date | null;
  freezesAvailable: number;
  freezesUsedTotal: number;
  status: StreakStatus;
}

/** A fresh `Streak` for a person's first-ever qualifying activity of a given `activityType`. */
export function initialStreakState(maxFreezes: number = MAX_FREEZES): StreakState {
  return {
    currentLength: 0,
    longestLength: 0,
    lastActivityDate: null,
    freezesAvailable: maxFreezes,
    freezesUsedTotal: 0,
    status: "active",
  };
}

export type StreakOutcome =
  /** The streak advanced to a new consecutive period without using a freeze — publishes `StreakExtended`. */
  | { kind: "extended"; state: StreakState }
  /** A missed cadence window was forgiven by consuming one freeze — publishes `StreakFrozen`. */
  | { kind: "frozen"; state: StreakState }
  /** A missed cadence window with no freezes available reset the streak — publishes `StreakBroken`. */
  | { kind: "broken"; state: StreakState }
  /**
   * The activity fell in the *same* cadence window as `lastActivityDate`
   * (e.g. a second approved hour entry the same week), or its date is not
   * after `lastActivityDate` at all (a redelivered/out-of-order event for an
   * activity type whose stream is otherwise monotonic) — no state change, no
   * event published. `currentLength` already reflects this period's
   * qualifying activity; a second one in the same period doesn't double it.
   */
  | { kind: "unchanged"; state: StreakState };

/** Midnight UTC of the Monday starting `date`'s ISO week — the cadence-window boundary. */
function startOfIsoWeek(date: Date): Date {
  const utcMidnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = utcMidnight.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Monday = 0
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - daysSinceMonday);
  return utcMidnight;
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Whole ISO weeks between `from` and `to`'s week-start dates (negative if `to` is earlier). */
function weeksBetween(from: Date, to: Date): number {
  return Math.round((startOfIsoWeek(to).getTime() - startOfIsoWeek(from).getTime()) / MS_PER_WEEK);
}

/**
 * Applies one qualifying activity (already idempotency-checked by the
 * caller — this function has no notion of "have I seen this event before")
 * to `current` streak state, implementing Streak invariants 1-3 exactly:
 *
 * 1. Same or next cadence window -> extend (or no-op if the *same* window).
 * 2. A window missed entirely -> consume a freeze (forgive) if any are
 *    available, else break.
 * 3. `freezesAvailable` never exceeds `maxFreezes`.
 */
export function applyStreakActivity(
  current: StreakState | null,
  activityDate: Date,
  maxFreezes: number = MAX_FREEZES,
): StreakOutcome {
  const base = current ?? initialStreakState(maxFreezes);

  if (base.lastActivityDate === null) {
    const currentLength = 1;
    return {
      kind: "extended",
      state: {
        ...base,
        currentLength,
        longestLength: Math.max(base.longestLength, currentLength),
        lastActivityDate: activityDate,
        status: "active",
      },
    };
  }

  const weekDiff = weeksBetween(base.lastActivityDate, activityDate);

  if (weekDiff <= 0) {
    return { kind: "unchanged", state: base };
  }

  if (weekDiff === 1) {
    const currentLength = base.currentLength + 1;
    return {
      kind: "extended",
      state: {
        ...base,
        currentLength,
        longestLength: Math.max(base.longestLength, currentLength),
        lastActivityDate: activityDate,
        status: "active",
      },
    };
  }

  // weekDiff > 1: at least one full cadence window was missed entirely.
  if (base.freezesAvailable > 0) {
    return {
      kind: "frozen",
      state: {
        ...base,
        freezesAvailable: Math.min(maxFreezes, base.freezesAvailable - 1),
        freezesUsedTotal: base.freezesUsedTotal + 1,
        lastActivityDate: activityDate,
        status: "frozen",
        // currentLength/longestLength preserved — the freeze forgives the
        // miss without resetting progress and without double-crediting the
        // activity that triggered it (invariant 2: "currentLength preserved").
      },
    };
  }

  return {
    kind: "broken",
    state: {
      ...base,
      currentLength: 0,
      lastActivityDate: activityDate,
      status: "broken",
      // longestLength/freezesAvailable/freezesUsedTotal preserved.
    },
  };
}
