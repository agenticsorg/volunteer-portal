import type { ModerationReportStatus } from "@prisma/client";

/**
 * Report status state machine (docs/ddd/moderation-trust-safety.md, Report
 * invariant 3 / the doc's own ASCII diagram): `open -> reviewing` (a
 * moderator claims it), `open -> dismissed` (fast-dismiss, no prior
 * claim), `reviewing -> resolved`, `reviewing -> dismissed`, `reviewing ->
 * open` (a moderator releases their claim). `resolved` and `dismissed` are
 * terminal — a still-live concern needs a new Report, never a transition
 * out of either.
 *
 * Kept as one explicit table, not scattered `!== "open"`/`!== "reviewing"`
 * checks inline in each use case, so the full legal-edge set has exactly
 * one source of truth `claimReport.ts`/`releaseReportClaim.ts`/
 * `resolveReport.ts`/`dismissReport.ts` all defer to — same "one pure,
 * exported predicate the application layer calls" shape
 * `training`'s `isModuleReadyToComplete`/`isCourseReadyToComplete` and
 * `gamification`'s `applyStreakActivity` already establish for their own
 * pure domain logic.
 */
const LEGAL_REPORT_STATUS_TRANSITIONS: Readonly<Record<ModerationReportStatus, readonly ModerationReportStatus[]>> = {
  open: ["reviewing", "dismissed"],
  reviewing: ["resolved", "dismissed", "open"],
  resolved: [],
  dismissed: [],
};

export function isLegalReportStatusTransition(
  from: ModerationReportStatus,
  to: ModerationReportStatus,
): boolean {
  return LEGAL_REPORT_STATUS_TRANSITIONS[from].includes(to);
}
