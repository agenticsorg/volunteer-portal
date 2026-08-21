/**
 * volunteering bounded-context module — public interface.
 *
 * Volunteering & Opportunities — Opportunity postings, Shifts, Applications, Hour Entry approval workflow.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 3 scope: the Opportunity/Shift/Application/HourEntry state
 * machines and every Key Use Case from
 * docs/ddd/volunteering-opportunities.md, gated through the shared
 * `@volunteer-portal/authz` `can()` policy module (ADR-0007) exactly the
 * way `modules/identity` gates its own privileged use cases. The tRPC
 * router (`server/api/routers/volunteering.ts`) is a thin adapter over the
 * use cases exported here, same split as Phase 2.
 */

// --- Opportunity ---
export { createOpportunity } from "./application/createOpportunity";
export type { CreateOpportunityInput, CreatedOpportunity } from "./application/createOpportunity";

export { publishOpportunity } from "./application/publishOpportunity";
export type { PublishOpportunityInput } from "./application/publishOpportunity";

export { closeOpportunity } from "./application/closeOpportunity";
export type { CloseOpportunityInput } from "./application/closeOpportunity";

export { archiveOpportunity } from "./application/archiveOpportunity";
export type { ArchiveOpportunityInput } from "./application/archiveOpportunity";

export { listOpportunities, getOpportunityById } from "./application/listOpportunities";
export type {
  ListOpportunitiesInput,
  ListOpportunitiesResult,
  OpportunityListItem,
} from "./application/listOpportunities";

export { searchOpportunities } from "./application/searchOpportunities";
export type { SearchOpportunitiesInput } from "./application/searchOpportunities";

// --- Shift ---
export { scheduleShift } from "./application/scheduleShift";
export type { ScheduleShiftInput, ScheduledShift } from "./application/scheduleShift";

export { cancelShift } from "./application/cancelShift";
export type { CancelShiftInput } from "./application/cancelShift";

export { listShiftsByOpportunity } from "./application/listShiftsByOpportunity";
export type { ShiftListItem } from "./application/listShiftsByOpportunity";

// --- Application ---
export { applyToShift } from "./application/applyToShift";
export type { ApplyToShiftInput, SubmittedApplication } from "./application/applyToShift";

export { decideApplication } from "./application/decideApplication";
export type {
  ApplicationDecision,
  DecideApplicationInput,
  DecidedApplication,
} from "./application/decideApplication";

export { withdrawApplication } from "./application/withdrawApplication";
export type { WithdrawApplicationInput } from "./application/withdrawApplication";

export { listApplicationsForShift } from "./application/listApplicationsForShift";
export type { ApplicationListItem } from "./application/listApplicationsForShift";

// --- HourEntry ---
export { submitHours } from "./application/submitHours";
export type { SubmitHoursInput, SubmittedHourEntry } from "./application/submitHours";

export { approveHours } from "./application/approveHours";
export type { ApproveHoursInput } from "./application/approveHours";

export { rejectHours } from "./application/rejectHours";
export type { RejectHoursInput } from "./application/rejectHours";

export { listHourEntriesForPerson } from "./application/listHourEntriesForPerson";
export type {
  HourEntryListItem,
  ListHourEntriesForPersonInput,
} from "./application/listHourEntriesForPerson";

/**
 * `volunteering.queryApprovedHours` — the grant-reporting read a much
 * later Admin & Reporting phase depends on (built now per the Phase 3
 * implementation prompt; see this function's own doc comment for why it
 * carries no `can()` gate itself).
 */
export { queryApprovedHours } from "./application/queryApprovedHours";
export type { ApprovedHourEntryRecord, QueryApprovedHoursFilters } from "./application/queryApprovedHours";

/**
 * The Training-context prerequisite check, stubbed for this phase — see
 * this function's own doc comment. Exported so a future router/use-case
 * caller (and Phase 4's replacement) has one obvious place to import it
 * from, same as every other cross-cutting check in this module.
 */
export { hasCompletedRequiredTraining } from "./application/hasCompletedRequiredTraining";

export {
  ForbiddenActionError,
  OpportunityNotFoundError,
  OpportunityNotPublishableError,
  InvalidOpportunityTransitionError,
  OpportunityHasScheduledShiftsError,
  ShiftNotFoundError,
  OpportunityNotPublishedError,
  ShiftTimeOrderError,
  ShiftCapacityInvalidError,
  ShiftNotOpenError,
  ShiftAlreadyDecidedError,
  ShiftHasApprovedHoursError,
  ApplicationNotFoundError,
  DuplicateApplicationError,
  ApplicationNotPendingError,
  NotTheApplicantError,
  ApplicationNotWithdrawableError,
  HourEntryNotFoundError,
  HourEntryNotSubmittedError,
  HourEntryDurationInvalidError,
  HourEntryTimeOrderError,
  HourEntryOutsideShiftWindowError,
  SelfApprovalNotAllowedError,
  RejectionReasonRequiredError,
  PersonNotFoundError,
} from "./domain/errors";
