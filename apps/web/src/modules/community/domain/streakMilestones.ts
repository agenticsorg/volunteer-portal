/**
 * `HandleStreakExtended`'s milestone filter (docs/ddd/community-social.md,
 * Integration & Anti-Corruption Notes): "only milestone streak lengths (7,
 * 30, 100 days, configurable via `admin` feature flag) produce a
 * `FeedEntry`; every other day's `StreakExtended` is acknowledged ... but
 * intentionally produces no feed row, to avoid daily feed spam."
 *
 * The doc's "configurable via `admin` feature flag" clause cannot be
 * honored literally yet — `modules/admin` is still an unimplemented stub
 * (`export {}`, no feature-flag store exists to read from). This constant
 * is the hardcoded default until that lands; when `admin` exposes a
 * feature-flag read, `isMilestoneStreakLength` is the one place that call
 * gets wired in.
 */
export const STREAK_MILESTONE_LENGTHS: readonly number[] = [7, 30, 100];

export function isMilestoneStreakLength(currentLength: number): boolean {
  return STREAK_MILESTONE_LENGTHS.includes(currentLength);
}
