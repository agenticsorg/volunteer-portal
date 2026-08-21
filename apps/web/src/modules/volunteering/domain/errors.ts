/**
 * Domain errors for the `volunteering` bounded context's Opportunity,
 * Shift, Application, and HourEntry aggregates (docs/ddd/
 * volunteering-opportunities.md). Thrown by the use cases under
 * `application/`; caught at the (future) tRPC procedure boundary
 * (`server/api/routers/volunteering.ts`) and translated to the appropriate
 * `TRPCError` code there — this module itself has no knowledge of tRPC,
 * same split as `modules/identity/domain/errors.ts`.
 */

/** A `can()` (ADR-0007) check denied the caller's requested action. */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/** No `volunteering.opportunities` row exists for the given id. */
export class OpportunityNotFoundError extends Error {
  constructor(opportunityId: string) {
    super(`No opportunity found for id "${opportunityId}".`);
    this.name = "OpportunityNotFoundError";
  }
}

/**
 * PublishOpportunity precondition: `title`/`description` non-empty, and
 * `chapterId` either `null` or referencing a chapter Identity currently
 * reports as active (Opportunity invariant 1).
 */
export class OpportunityNotPublishableError extends Error {
  constructor(opportunityId: string, reason: string) {
    super(`Opportunity "${opportunityId}" cannot be published: ${reason}`);
    this.name = "OpportunityNotPublishableError";
  }
}

/**
 * A transition was attempted from a status the Opportunity state machine
 * does not allow it from (e.g. publishing an already-published Opportunity,
 * archiving one that isn't `closed`) — Opportunity invariant 2 ("once
 * `published`, `status` never returns to `draft`") and the documented
 * `draft -> published -> closed -> archived` path generally.
 */
export class InvalidOpportunityTransitionError extends Error {
  constructor(opportunityId: string, from: string, to: string) {
    super(`Opportunity "${opportunityId}" cannot transition from "${from}" to "${to}".`);
    this.name = "InvalidOpportunityTransitionError";
  }
}

/** Opportunity invariant 4: cannot archive while any Shift is `scheduled`. */
export class OpportunityHasScheduledShiftsError extends Error {
  constructor(opportunityId: string) {
    super(
      `Opportunity "${opportunityId}" has one or more "scheduled" shifts — ` +
        "cancel or complete them before archiving.",
    );
    this.name = "OpportunityHasScheduledShiftsError";
  }
}

/** No `volunteering.shifts` row exists for the given id. */
export class ShiftNotFoundError extends Error {
  constructor(shiftId: string) {
    super(`No shift found for id "${shiftId}".`);
    this.name = "ShiftNotFoundError";
  }
}

/** ScheduleShift precondition: the parent Opportunity must be `published`. */
export class OpportunityNotPublishedError extends Error {
  constructor(opportunityId: string) {
    super(`Opportunity "${opportunityId}" is not published.`);
    this.name = "OpportunityNotPublishedError";
  }
}

/** Shift invariant 1: `endsAt` must be strictly after `startsAt`. */
export class ShiftTimeOrderError extends Error {
  constructor() {
    super("A shift's endsAt must be strictly after its startsAt.");
    this.name = "ShiftTimeOrderError";
  }
}

/** Shift invariant 2: `capacity >= 1`. */
export class ShiftCapacityInvalidError extends Error {
  constructor() {
    super("A shift's capacity must be at least 1.");
    this.name = "ShiftCapacityInvalidError";
  }
}

/** ApplyToShift precondition: the shift must be `scheduled` and in the future. */
export class ShiftNotOpenError extends Error {
  constructor(shiftId: string, reason: string) {
    super(`Shift "${shiftId}" is not open for applications: ${reason}`);
    this.name = "ShiftNotOpenError";
  }
}

/** CancelShift precondition (Key Use Case 3 / Shift invariant 4). */
export class ShiftAlreadyDecidedError extends Error {
  constructor(shiftId: string, status: string) {
    super(`Shift "${shiftId}" is already "${status}" and cannot be cancelled.`);
    this.name = "ShiftAlreadyDecidedError";
  }
}

/** Shift invariant 4: a shift with an `approved` HourEntry cannot be cancelled. */
export class ShiftHasApprovedHoursError extends Error {
  constructor(shiftId: string) {
    super(`Shift "${shiftId}" has an approved hour entry and cannot be cancelled.`);
    this.name = "ShiftHasApprovedHoursError";
  }
}

/** No `volunteering.applications` row exists for the given id. */
export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`No application found for id "${applicationId}".`);
    this.name = "ApplicationNotFoundError";
  }
}

/**
 * Application invariant 1: at most one non-terminal-or-accepted Application
 * per `(applicantPersonId, shiftId)`.
 */
export class DuplicateApplicationError extends Error {
  constructor(applicantPersonId: string, shiftId: string) {
    super(
      `Person "${applicantPersonId}" already has an active application for shift "${shiftId}".`,
    );
    this.name = "DuplicateApplicationError";
  }
}

/**
 * DecideApplication precondition: the Application must be `pending` for
 * `accept`/`waitlist`, or `pending`/`waitlisted` for `decline`.
 */
export class ApplicationNotPendingError extends Error {
  constructor(applicationId: string, status: string) {
    super(`Application "${applicationId}" is "${status}", not "pending".`);
    this.name = "ApplicationNotPendingError";
  }
}

/**
 * WithdrawApplication precondition (Key Use Case 6): only callable by the
 * applicant themself.
 */
export class NotTheApplicantError extends Error {
  constructor(applicationId: string) {
    super(`Only the applicant may withdraw application "${applicationId}".`);
    this.name = "NotTheApplicantError";
  }
}

/** WithdrawApplication precondition: status must be pending/accepted/waitlisted. */
export class ApplicationNotWithdrawableError extends Error {
  constructor(applicationId: string, status: string) {
    super(`Application "${applicationId}" is "${status}" and cannot be withdrawn.`);
    this.name = "ApplicationNotWithdrawableError";
  }
}

/** No `volunteering.hour_entries` row exists for the given id. */
export class HourEntryNotFoundError extends Error {
  constructor(hourEntryId: string) {
    super(`No hour entry found for id "${hourEntryId}".`);
    this.name = "HourEntryNotFoundError";
  }
}

/**
 * ADR-0014 / HourEntry invariant 3: once `status = 'approved'`, the row is
 * immutable. Also doubles as the Approve/Reject precondition guard
 * ("`HourEntry.status = 'submitted'`") — thrown for any attempt to
 * approve/reject a row that isn't currently `submitted`, which is exactly
 * what makes a second approve/reject of an already-decided row impossible
 * through this module's own code paths (defense-in-depth alongside the DB
 * trigger `trg_hour_entries_immutable`).
 */
export class HourEntryNotSubmittedError extends Error {
  constructor(hourEntryId: string, status: string) {
    super(`Hour entry "${hourEntryId}" is "${status}", not "submitted" — it cannot be mutated.`);
    this.name = "HourEntryNotSubmittedError";
  }
}

/** HourEntry invariant 1: `0 < durationMinutes <= 1440`. */
export class HourEntryDurationInvalidError extends Error {
  constructor() {
    super("An hour entry's duration must be more than 0 and at most 1440 minutes (24 hours).");
    this.name = "HourEntryDurationInvalidError";
  }
}

/** HourEntry time fields: `endAt` must be strictly after `startAt`. */
export class HourEntryTimeOrderError extends Error {
  constructor() {
    super("An hour entry's endAt must be strictly after its startAt.");
    this.name = "HourEntryTimeOrderError";
  }
}

/**
 * HourEntry invariant 5: when `shiftId` is set, `startAt`/`endAt` must fall
 * within a reasonable tolerance window of that Shift's `startsAt`/`endsAt`.
 */
export class HourEntryOutsideShiftWindowError extends Error {
  constructor(shiftId: string) {
    super(`Hour entry's start/end time falls outside a reasonable window of shift "${shiftId}".`);
    this.name = "HourEntryOutsideShiftWindowError";
  }
}

/**
 * HourEntry invariant 2: "the approver may not be the same Person as
 * `personId`" — no self-approval, no self-rejection.
 */
export class SelfApprovalNotAllowedError extends Error {
  constructor(hourEntryId: string) {
    super(`Person cannot approve/reject their own hour entry "${hourEntryId}".`);
    this.name = "SelfApprovalNotAllowedError";
  }
}

/** HourEntry invariant 4: `reject` requires a non-empty `rejectionReason`. */
export class RejectionReasonRequiredError extends Error {
  constructor() {
    super("Rejecting an hour entry requires a non-empty rejectionReason.");
    this.name = "RejectionReasonRequiredError";
  }
}

/** SubmitHours/ApplyToShift precondition: the referenced Opportunity/Person must exist. */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}
