/**
 * Domain errors for the `identity` bounded context's Person aggregate.
 * Thrown by `application/registerPerson.ts`; caught at the tRPC procedure
 * boundary (`server/api/routers/identity.ts`) and translated to the
 * appropriate `TRPCError` code there — this module itself has no
 * knowledge of tRPC.
 */

/** A Person already exists for this `supabaseAuthId` (unique per ADR-0006). */
export class PersonAlreadyRegisteredError extends Error {
  constructor(supabaseAuthId: string) {
    super(`A person is already registered for supabaseAuthId "${supabaseAuthId}".`);
    this.name = "PersonAlreadyRegisteredError";
  }
}

/**
 * `identity.persons`' `chk_persons_age_gate` CHECK requires either a date
 * of birth or an explicit 16+ attestation before a (non-anonymized) row
 * can exist. Enforced here too, app-side, so registration fails with a
 * clear domain error instead of a raw Postgres constraint-violation
 * message.
 */
export class AgeGateError extends Error {
  constructor() {
    super(
      "Registration requires either a date of birth or a 16-plus age " +
        "attestation (identity.persons chk_persons_age_gate).",
    );
    this.name = "AgeGateError";
  }
}

/**
 * `consent_records`' `chk_consent_guardian_fields` CHECK requires both
 * guardian fields together whenever a `guardian_consent` record is
 * written.
 */
export class IncompleteGuardianConsentError extends Error {
  constructor() {
    super("Guardian consent requires both guardianName and guardianEmail.");
    this.name = "IncompleteGuardianConsentError";
  }
}

/**
 * Person invariant 2 (age gate), the under-16 branch: a supplied
 * `dateOfBirth` computes to under 16 years old, and no (complete)
 * `guardianConsent` was supplied in the same request. Distinct from
 * `AgeGateError` (neither a DOB nor a 16+ attestation was supplied at
 * all) and from `IncompleteGuardianConsentError` (guardian consent was
 * supplied but missing a required field) — this is the case where a DOB
 * was supplied, real date arithmetic says the registrant is under 16, and
 * *no* guardian consent came with the request at all.
 */
export class GuardianConsentRequiredError extends Error {
  constructor() {
    super(
      "The supplied date of birth indicates the registrant is under 16 — " +
        "an accompanying guardian_consent (guardianName + guardianEmail) " +
        "is required (identity-access.md Person invariant 2).",
    );
    this.name = "GuardianConsentRequiredError";
  }
}

/**
 * A `can()` (ADR-0007) check denied the caller's requested action.
 * Thrown by every privileged use case in this module before it performs
 * any write — translated to `TRPCError({ code: "FORBIDDEN" })` at the
 * router boundary.
 */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/** No active `identity.role_assignments` row matches the given id. */
export class RoleAssignmentNotFoundError extends Error {
  constructor(roleAssignmentId: string) {
    super(`No active role assignment found for id "${roleAssignmentId}".`);
    this.name = "RoleAssignmentNotFoundError";
  }
}

/**
 * `role_assignments`' `chk_role_assignments_scope` CHECK: `scopeType =
 * 'global' ⟺ scopeId IS NULL`; `scopeType ∈ {chapter, team} ⟺ scopeId IS
 * NOT NULL`.
 */
export class InvalidRoleScopeError extends Error {
  constructor() {
    super(
      "scopeId must be null for scopeType 'global', and non-null for " +
        "'chapter'/'team' (identity.role_assignments chk_role_assignments_scope).",
    );
    this.name = "InvalidRoleScopeError";
  }
}

/** No `identity.persons` row exists for the given id. */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}

/** RecordConsent's precondition: "`personId` refers to an *active* Person." */
export class PersonNotActiveError extends Error {
  constructor(personId: string) {
    super(`Person "${personId}" is not active.`);
    this.name = "PersonNotActiveError";
  }
}

/** RevokeConsent's precondition: an active (non-revoked) ConsentRecord must exist. */
export class NoActiveConsentError extends Error {
  constructor(personId: string, purpose: string) {
    super(`No active consent of purpose "${purpose}" found for person "${personId}".`);
    this.name = "NoActiveConsentError";
  }
}

/**
 * DSARRequest invariant 3: "Only one *open* (`pending`/`processing`)
 * request of a given `type` may exist per `personId` at a time."
 */
export class OpenDsarRequestExistsError extends Error {
  constructor(personId: string, type: string) {
    super(`An open ${type} DSAR request already exists for person "${personId}".`);
    this.name = "OpenDsarRequestExistsError";
  }
}

/** Erasure was requested for a Person already `status = 'anonymized'` (terminal). */
export class PersonAlreadyAnonymizedError extends Error {
  constructor(personId: string) {
    super(`Person "${personId}" is already anonymized.`);
    this.name = "PersonAlreadyAnonymizedError";
  }
}

/** No `identity.chapters` row exists for the given id. */
export class ChapterNotFoundError extends Error {
  constructor(chapterId: string) {
    super(`No chapter found for id "${chapterId}".`);
    this.name = "ChapterNotFoundError";
  }
}

/** `chapters.slug` UNIQUE constraint. */
export class ChapterSlugTakenError extends Error {
  constructor(slug: string) {
    super(`Chapter slug "${slug}" is already taken.`);
    this.name = "ChapterSlugTakenError";
  }
}

/**
 * Chapter invariant 2: "`leadPersonId`, when set, must correspond to a
 * Person holding an active `chapter_lead` role assignment scoped to this
 * chapter — enforced at the `AssignChapterLead` application-layer use
 * case."
 */
export class NotAnActiveChapterLeadError extends Error {
  constructor(personId: string, chapterId: string) {
    super(
      `Person "${personId}" does not hold an active chapter_lead role assignment ` +
        `scoped to chapter "${chapterId}" — grant the role first via GrantRole.`,
    );
    this.name = "NotAnActiveChapterLeadError";
  }
}

/** A DSAR export was requested/fetched that has not (yet) reached `completed`. */
export class DsarExportNotReadyError extends Error {
  constructor(dsarId: string) {
    super(`DSAR export "${dsarId}" is not ready for download yet.`);
    this.name = "DsarExportNotReadyError";
  }
}

/** No `identity.dsar_requests` row exists for the given id. */
export class DsarRequestNotFoundError extends Error {
  constructor(dsarId: string) {
    super(`No DSAR request found for id "${dsarId}".`);
    this.name = "DsarRequestNotFoundError";
  }
}
