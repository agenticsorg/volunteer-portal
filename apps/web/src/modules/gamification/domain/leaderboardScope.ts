import { UnscopedLeaderboardError } from "./errors";

/**
 * The `LeaderboardScope` value object (docs/ddd/gamification.md): a
 * leaderboard is always scoped to exactly one Team or one Challenge, both
 * owned by `community` and referenced here by id only (no FK — ADR-0001).
 * `scopeType` has no `'global'` member — not merely by convention, but
 * because the type itself cannot represent it, per this context's hard
 * "leaderboards are never global" rule.
 */
export type LeaderboardScopeType = "team" | "challenge";

export interface LeaderboardScope {
  scopeType: LeaderboardScopeType;
  scopeId: string;
}

const VALID_SCOPE_TYPES: ReadonlySet<string> = new Set<LeaderboardScopeType>(["team", "challenge"]);

/**
 * Runtime backstop for the same invariant the `LeaderboardScopeType` union
 * already enforces at compile time — every leaderboard read/write
 * (`getLeaderboard`, `rebuildLeaderboardSnapshot`) calls this first, so a
 * caller that bypasses the type system (an `any` cast, a malformed request
 * once the API layer exists) still cannot produce or read an unscoped,
 * platform-wide ranking. See `UnscopedLeaderboardError`'s own doc comment.
 */
export function assertScopedLeaderboard(scope: { scopeType: string; scopeId: string }): asserts scope is LeaderboardScope {
  if (!VALID_SCOPE_TYPES.has(scope.scopeType) || !scope.scopeId) {
    throw new UnscopedLeaderboardError(scope.scopeType);
  }
}
