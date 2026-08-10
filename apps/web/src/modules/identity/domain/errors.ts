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
