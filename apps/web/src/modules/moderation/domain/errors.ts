/**
 * Domain errors for the `moderation` bounded context (docs/ddd/
 * moderation-trust-safety.md). Thrown by the use cases under
 * `application/`; caught at the (future) tRPC procedure boundary and
 * translated to the appropriate `TRPCError` code there — this module
 * itself has no knowledge of tRPC, same split as every other module's
 * `domain/errors.ts`.
 */

/** No `identity.person` row exists for the given id (reporter, target, or moderator). */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}

/** Report invariant 1: `reporterPersonId <> reportedEntityId` when `reportedEntityType = 'identity.person'`. */
export class SelfReportNotAllowedError extends Error {
  constructor() {
    super("A person cannot file a report against themselves.");
    this.name = "SelfReportNotAllowedError";
  }
}

/**
 * `FileReport`'s snapshot resolver has no owning-context Open Host Service
 * read wired up yet for this `reportedEntityType` (see
 * `application/resolveReportedEntitySnapshot.ts`'s own header comment for
 * exactly which types are and are not supported yet). Thrown rather than
 * fabricating a snapshot via a live cross-schema join, which the anti-
 * corruption boundary this aggregate exists for explicitly forbids.
 */
export class UnsupportedReportedEntityTypeError extends Error {
  constructor(reportedEntityType: string) {
    super(
      `No content-snapshot Open Host Service read is wired up yet for reportedEntityType "${reportedEntityType}".`,
    );
    this.name = "UnsupportedReportedEntityTypeError";
  }
}

/** `FileReport`'s snapshot resolver ran, but the owning context reports no such entity exists. */
export class ReportedEntityNotFoundError extends Error {
  constructor(reportedEntityType: string, reportedEntityId: string) {
    super(`No "${reportedEntityType}" entity found for id "${reportedEntityId}".`);
    this.name = "ReportedEntityNotFoundError";
  }
}

/** No `moderation.report` row exists for the given id. */
export class ReportNotFoundError extends Error {
  constructor(reportId: string) {
    super(`No report found for id "${reportId}".`);
    this.name = "ReportNotFoundError";
  }
}

/**
 * Report status state machine (docs/ddd/moderation-trust-safety.md,
 * invariant 3): the requested transition is not one of the legal edges
 * (`open -> reviewing`, `open -> dismissed`, `reviewing -> resolved`,
 * `reviewing -> dismissed`, `reviewing -> open`). `resolved`/`dismissed`
 * are terminal.
 */
export class InvalidReportStatusTransitionError extends Error {
  constructor(fromStatus: string, toStatus: string) {
    super(`Report cannot transition from "${fromStatus}" to "${toStatus}".`);
    this.name = "InvalidReportStatusTransitionError";
  }
}

/**
 * A `can()` (ADR-0007) scope-authority check denied the caller — either
 * `ClaimReport`/the open-report branch of `DismissReport` (the caller's
 * moderator scope does not cover the Report's own scope) or
 * `TakeModerationAction` (the caller's moderator scope does not cover the
 * requested action's own scope). Named `OUT_OF_SCOPE` to match
 * docs/ddd/moderation-trust-safety.md's API Contract Sketch's own
 * documented throw.
 */
export class OutOfScopeError extends Error {
  constructor(action: string) {
    super(`Caller's moderator authority does not cover the scope required for "${action}".`);
    this.name = "OUT_OF_SCOPE";
  }
}

/**
 * `ResolveReport`/`DismissReport`'s reviewing-report branch,
 * `ReleaseReportClaim`, or `RevokeModerationAction`: the caller is neither
 * the claim-holder/issuing moderator nor an `org_admin` (Report invariant
 * 4 / ModerationAction invariant 4).
 */
export class NotClaimHolderError extends Error {
  constructor(action: string) {
    super(`Only the claim holder (or an org_admin) may perform "${action}".`);
    this.name = "NotClaimHolderError";
  }
}

/** No `moderation.moderation_action` row exists for the given id. */
export class ModerationActionNotFoundError extends Error {
  constructor(actionId: string) {
    super(`No moderation action found for id "${actionId}".`);
    this.name = "ModerationActionNotFoundError";
  }
}

/**
 * ModerationAction invariant 1: `warn` and `ban` must never carry an
 * `endsAt`; `mute`/`suspend` must have `endsAt` explicitly provided as
 * either a future timestamp or `null` (never silently defaulted). Named
 * `INVALID_DURATION_FOR_ACTION_TYPE` to match the API Contract Sketch's
 * own documented throw.
 */
export class InvalidDurationForActionTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "INVALID_DURATION_FOR_ACTION_TYPE";
  }
}

/**
 * `TakeModerationAction`'s own scope-shape precondition (mirrors
 * `identity.grantRole`'s `assertValidScope`): `scopeType = 'org'` must
 * carry `scopeId: null`; `scopeType = 'chapter'` must carry a non-null
 * `scopeId` — the same `CHECK ((scope_type = 'org') = (scope_id IS
 * NULL))` the Schema Sketch enforces at the DB level.
 */
export class InvalidScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScopeError";
  }
}

/**
 * ModerationAction invariant 3 (second half): "a `ban` is ALWAYS
 * org-scoped regardless of where the report originated." Thrown when a
 * caller explicitly requests a non-`org` scope for a `ban`, rather than
 * silently overriding the requested scope — the DB's own
 * `chk_moderation_action_ban_org` CHECK is the defense-in-depth backstop,
 * not the primary signal to the caller.
 */
export class BanMustBeOrgScopedError extends Error {
  constructor() {
    super("A ban is always org-scoped, regardless of where the report originated.");
    this.name = "BanMustBeOrgScopedError";
  }
}

/** ModerationAction invariant 4: only an already-`active` action may be revoked. */
export class ModerationActionNotActiveError extends Error {
  constructor(actionId: string, status: string) {
    super(`Moderation action "${actionId}" is "${status}", not "active" — cannot revoke.`);
    this.name = "ModerationActionNotActiveError";
  }
}

/**
 * An R2-backed adapter call (docs/ddd/moderation-trust-safety.md's
 * EvidenceAttachment value object; ADR-0011) requires an environment
 * variable that is not set in this environment. Thrown instead of faking
 * success — see `infra/cloudflareR2Client.ts`'s own header comment.
 */
export class ExternalServiceNotConfiguredError extends Error {
  constructor(missingEnvVar: string, purpose: string) {
    super(`${purpose} requires the "${missingEnvVar}" environment variable, which is not set.`);
    this.name = "ExternalServiceNotConfiguredError";
  }
}
