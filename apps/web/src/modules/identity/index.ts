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
 * Phase 2 scope: the RegisterPerson anti-corruption translation
 * (ADR-0006), its read-side counterpart, and every other Key Use Case
 * from docs/ddd/identity-access.md (GrantRole, RevokeRole, RecordConsent,
 * RevokeConsent, RequestDataExport, RequestErasure/AnonymizePerson,
 * CreateChapter, AssignChapterLead) — gated through the shared
 * `@volunteer-portal/authz` `can()` policy module (ADR-0007).
 */
export { registerPerson } from "./application/registerPerson";
export type {
  GuardianConsentInput,
  RegisterPersonInput,
  RegisteredPerson,
} from "./application/registerPerson";

export { findPersonByAuthId } from "./application/findPersonByAuthId";
export type { PersonSummary } from "./application/findPersonByAuthId";

/**
 * The sanctioned cross-context read (identity-access-schema-api.md's
 * `getPersonSummary` — an Open Host Service). Every other bounded-context
 * module that needs to display a `personId`'s name/avatar must go through
 * this function; nothing else exported below reads Person data in a form
 * a caller outside this module's own tRPC router should ever consume.
 */
export { getPersonSummary } from "./application/getPersonSummary";
export type { PersonPublicSummary } from "./application/getPersonSummary";

export { listActiveRoleAssignments, listRoleAssignmentHistory } from "./application/listActiveRoleAssignments";
export type { RoleAssignmentRecord } from "./application/listActiveRoleAssignments";

export { grantRole } from "./application/grantRole";
export type { GrantRoleInput, GrantedRole } from "./application/grantRole";

export { revokeRole } from "./application/revokeRole";
export type { RevokeRoleInput } from "./application/revokeRole";

export { recordConsent } from "./application/recordConsent";
export type { ConsentSource, RecordConsentInput, RecordedConsent } from "./application/recordConsent";

export { revokeConsent } from "./application/revokeConsent";
export type { RevokeConsentInput } from "./application/revokeConsent";

export { createChapter } from "./application/createChapter";
export type { CreateChapterInput, CreatedChapter } from "./application/createChapter";

export { assignChapterLead } from "./application/assignChapterLead";
export type { AssignChapterLeadInput } from "./application/assignChapterLead";

export { listChapters } from "./application/listChapters";
export type { ChapterListItem, ListChaptersInput } from "./application/listChapters";

export { getConsentForPerson } from "./application/getConsentForPerson";
export type { CurrentConsentRecord } from "./application/getConsentForPerson";

export { requestDataExport } from "./application/requestDataExport";
export type { RequestDataExportInput, RequestedDataExport } from "./application/requestDataExport";

export { requestErasure } from "./application/requestErasure";
export type { RequestErasureInput, ErasureResult } from "./application/requestErasure";

export { getDsarStatus } from "./application/getDsarStatus";
export type { DsarRequestStatus } from "./application/getDsarStatus";

export {
  AgeGateError,
  IncompleteGuardianConsentError,
  PersonAlreadyRegisteredError,
  ForbiddenActionError,
  RoleAssignmentNotFoundError,
  InvalidRoleScopeError,
  PersonNotFoundError,
  PersonNotActiveError,
  NoActiveConsentError,
  OpenDsarRequestExistsError,
  PersonAlreadyAnonymizedError,
  ChapterNotFoundError,
  ChapterSlugTakenError,
  NotAnActiveChapterLeadError,
  DsarExportNotReadyError,
  DsarRequestNotFoundError,
} from "./domain/errors";
