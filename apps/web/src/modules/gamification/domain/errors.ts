/**
 * Domain errors for the `gamification` bounded context (docs/ddd/
 * gamification.md). Thrown by the use cases under `application/`; caught at
 * the (future) tRPC procedure boundary (`server/api/routers/gamification.ts`)
 * and translated to the appropriate `TRPCError` code there — this module
 * itself has no knowledge of tRPC, same split as every other module's
 * `domain/errors.ts`.
 */

/** A `can()` (ADR-0007) check denied the caller's requested action. */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/**
 * `GetLeaderboard`/`RebuildLeaderboardSnapshot` precondition, enforced at
 * runtime as well as at the type level (`LeaderboardScope["scopeType"]` is a
 * `'team' | 'challenge'` union with no `'global'` member) — this context's
 * hard invariant that a leaderboard is never global/platform-wide (docs/ddd/
 * gamification.md, Leaderboard invariant). The runtime check exists for
 * callers that can bypass the type system (an `any`-typed caller, a
 * malformed request body once the API layer exists) — "assert this at the
 * API layer itself, not just by code-review convention" per the Phase 5
 * completion bar, satisfied here at the one application-layer choke point
 * every leaderboard read/write already passes through.
 */
export class UnscopedLeaderboardError extends Error {
  constructor(scopeType: string) {
    super(
      `Leaderboards must be scoped to a "team" or "challenge" — "${scopeType}" is not a valid scope. ` +
        "A global/platform-wide leaderboard is not supported.",
    );
    this.name = "UnscopedLeaderboardError";
  }
}

/** AdminAdjustPoints precondition: `reason` is required for a `ManualAdjustment` ledger entry. */
export class ManualAdjustmentReasonRequiredError extends Error {
  constructor() {
    super("A manual points adjustment requires a non-empty reason.");
    this.name = "ManualAdjustmentReasonRequiredError";
  }
}

/** No `gamification.badge` row exists for the given id. */
export class BadgeNotFoundError extends Error {
  constructor(badgeId: string) {
    super(`No badge found for id "${badgeId}".`);
    this.name = "BadgeNotFoundError";
  }
}

/** AdminAdjustPoints/AdminAwardBadge precondition: the target Person must exist (per `identity.getPersonSummary`). */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}
