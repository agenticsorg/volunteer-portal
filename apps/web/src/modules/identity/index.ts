/**
 * identity bounded-context module — public interface.
 *
 * Identity & Access — Person identity, Chapter, scoped role assignments, GDPR consent/DSAR.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 2 scope: the RegisterPerson anti-corruption translation (ADR-0006)
 * and its read-side counterpart only — Chapter/RoleAssignment/Consent/DSAR
 * use cases beyond initial-registration consent are not built yet.
 */
export { registerPerson } from "./application/registerPerson";
export type {
  GuardianConsentInput,
  RegisterPersonInput,
  RegisteredPerson,
} from "./application/registerPerson";

export { findPersonByAuthId } from "./application/findPersonByAuthId";
export type { PersonSummary } from "./application/findPersonByAuthId";

export {
  AgeGateError,
  IncompleteGuardianConsentError,
  PersonAlreadyRegisteredError,
} from "./domain/errors";
