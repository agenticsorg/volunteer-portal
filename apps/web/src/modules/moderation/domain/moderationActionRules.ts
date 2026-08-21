import { BanMustBeOrgScopedError, InvalidDurationForActionTypeError, InvalidScopeError } from "./errors";

/**
 * The enforcement-ladder rung vocabulary (docs/ddd/moderation-trust-safety.md
 * "Moderation Action"). Defined here, in the domain layer, rather than
 * imported from `application/takeModerationAction.ts`'s own identically-
 * named type — domain must not depend on application (ADR-0001's layering);
 * the two stay structurally identical by construction, same "one closed
 * set duplicated at the layer boundary it's needed at" shape this module's
 * own `ReportedEntityType`/`ReportReason` (`reportedEntityTypes.ts`) avoid
 * needing in the first place only because those have no application-layer
 * counterpart to duplicate against.
 */
export type ModerationActionType = "warn" | "mute" | "suspend" | "ban";

/**
 * `TakeModerationAction`'s own scope-shape precondition (docs/ddd/
 * moderation-trust-safety.md's Schema Sketch: `CHECK ((scope_type = 'org')
 * = (scope_id IS NULL))`, mirrored at the application layer so a caller
 * gets a clear domain error before ever reaching the DB's own defense-in-
 * depth CHECK). Pure — no DB, no Prisma — so it is unit-testable directly,
 * same "pure predicate the application layer calls" shape
 * `reportStateMachine.ts`'s own header comment establishes.
 */
export function assertValidModerationActionScope(scopeType: "org" | "chapter", scopeId: string | null): void {
  const scopeIdRequired = scopeType === "chapter";
  if (scopeIdRequired !== (scopeId !== null)) {
    throw new InvalidScopeError(
      scopeIdRequired
        ? "A chapter-scoped moderation action must carry a scopeId."
        : "An org-scoped moderation action must not carry a scopeId.",
    );
  }
}

/**
 * ModerationAction invariant 3 (second half): "a `ban` is ALWAYS
 * org-scoped, regardless of where the report originated." Enforced here,
 * explicitly, before `can()`'s own scope-authority check runs — see
 * `takeModerationAction.ts`'s own doc comment for why this order matters.
 */
export function assertBanIsAlwaysOrgScoped(actionType: ModerationActionType, scopeType: "org" | "chapter"): void {
  if (actionType === "ban" && scopeType !== "org") {
    throw new BanMustBeOrgScopedError();
  }
}

/**
 * ModerationAction invariants 1-2: `warn`/`ban` must never carry an
 * `endsAt` (never time-boxed); `mute`/`suspend` must have `endsAt`
 * explicitly provided as either a future timestamp or `null` (never
 * silently defaulted — "the choice must be explicit, not defaulted
 * silently").
 */
export function assertValidModerationActionDuration(
  actionType: ModerationActionType,
  endsAt: string | null | undefined,
): void {
  if (actionType === "warn" || actionType === "ban") {
    if (endsAt !== undefined && endsAt !== null) {
      throw new InvalidDurationForActionTypeError(
        `A "${actionType}" must not carry an endsAt (it is never time-boxed).`,
      );
    }
    return;
  }
  // mute / suspend
  if (endsAt === undefined) {
    throw new InvalidDurationForActionTypeError(
      `A "${actionType}" requires endsAt to be explicitly set — a future timestamp for a bounded sanction, or ` +
        "null for an indefinite one pending manual review. It cannot be omitted.",
    );
  }
  if (endsAt !== null) {
    const parsed = new Date(endsAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw new InvalidDurationForActionTypeError(`A "${actionType}"'s endsAt must be a future timestamp, or null.`);
    }
  }
}
