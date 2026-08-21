/**
 * moderation bounded-context module — public interface.
 *
 * Moderation — report intake/review pipeline, the graduated enforcement
 * ladder (warn → mute → suspend → ban), scoped org-wide or per-Chapter.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 7 scope: the domain/application layer — the Report and
 * ModerationAction aggregates and every Key Use Case from docs/ddd/
 * moderation-trust-safety.md's Build list (FileReport, ClaimReport,
 * ReleaseReportClaim, ResolveReport, DismissReport, TakeModerationAction,
 * RevokeModerationAction), the Report status state machine (`open ->
 * reviewing -> resolved|dismissed`), and ModerationAction's scope-authority
 * rules (a chapter-scoped moderator may only issue chapter-scoped actions
 * within their own chapter; a `ban` is always `org`-scoped regardless of
 * report origin) — gated through `@volunteer-portal/authz`'s `can()`
 * (ADR-0007), Person data resolved only via `identity.getPersonSummary`,
 * and `reportedContentSnapshot` captured once, at file-time, via the
 * owning context's own snapshot query (`community.getPostSnapshot`,
 * `identity.getPersonSummary`), never a live join, never re-synced — plus
 * the two Open Host Service reads a later phase depends on already
 * existing (`getActiveActionsForPerson`, `queryModerationHistory`), and
 * this stage's own required Phase 6 follow-through: `community.createPost`
 * and `community.giveKudos` now call `getActiveActionsForPerson` before
 * allowing the write and reject it if an active `suspend`/`ban` covers the
 * write's own scope (see those two files' own doc comments).
 *
 * CRITICAL, already-resolved constraint (ADR-0014 §4): this schema does
 * NOT define a `moderation.audit_log` table, and none should ever be
 * added. Every privileged mutation below (`FileReport`, `ClaimReport`,
 * `ReleaseReportClaim`, `ResolveReport`, `DismissReport`,
 * `TakeModerationAction`, `RevokeModerationAction`) writes through Phase
 * 1's shared `@volunteer-portal/audit` `recordAuditEvent()` into the
 * single, shared `admin.audit_log`, exactly like every other bounded
 * context.
 *
 * Deliberately NOT in this stage (a later stage's job, or explicitly out
 * of this stage's Build list): the tRPC router/REST layer
 * (`server/api/routers/moderation.ts`); `ExpireModerationActions` (the
 * hourly `graphile-worker` sweep — Key Use Case 8, not named in this
 * phase's own Build list); the `community`/`notifications` event
 * consumers that react to `ModerationActionTaken`/`Revoked`/`Expired`
 * (`HandleModerationActionTaken` and friends — those modules' own future
 * stages' job, not this one's, per `community`'s own index.ts header
 * already noting `moderation` "doesn't exist yet" when Phase 6 was built).
 */

// --- Reports ---
export { fileReport } from "./application/fileReport";
export type { EvidenceAttachmentInput, FileReportInput, FiledReport } from "./application/fileReport";

export { claimReport } from "./application/claimReport";
export type { ClaimReportInput, ClaimedReport } from "./application/claimReport";

export { releaseReportClaim } from "./application/releaseReportClaim";
export type { ReleaseReportClaimInput, ReleasedReportClaim } from "./application/releaseReportClaim";

export { resolveReport } from "./application/resolveReport";
export type { ResolveReportInput, ResolvedReport } from "./application/resolveReport";

export { dismissReport } from "./application/dismissReport";
export type { DismissReportInput, DismissedReport } from "./application/dismissReport";

// --- Moderation actions (the enforcement ladder) ---
export { takeModerationAction } from "./application/takeModerationAction";
export type {
  ModerationActionType,
  TakeModerationActionInput,
  TakenModerationAction,
} from "./application/takeModerationAction";

export { revokeModerationAction } from "./application/revokeModerationAction";
export type { RevokeModerationActionInput, RevokedModerationAction } from "./application/revokeModerationAction";

// --- Open Host Service reads ---
export { getActiveActionsForPerson } from "./application/getActiveActionsForPerson";
export type { ActiveActionsScope, ActiveModerationActionSummary } from "./application/getActiveActionsForPerson";

export { queryModerationHistory } from "./application/queryModerationHistory";
export type {
  ModerationHistoryEntryDto,
  ModerationHistoryPage,
  ModerationHistoryResolutionActionDto,
  QueryModerationHistoryFilters,
} from "./application/queryModerationHistory";

// --- Reported-entity vocabulary (closed sets) ---
export { REPORTED_ENTITY_TYPES, isReportedEntityType } from "./domain/reportedEntityTypes";
export type { ReportedEntityType } from "./domain/reportedEntityTypes";
export { REPORT_REASONS } from "./domain/reportedEntityTypes";
export type { ReportReason } from "./domain/reportedEntityTypes";

// --- Pure domain logic (state machine, scope-rule enforcement) ---
export { isLegalReportStatusTransition } from "./domain/reportStateMachine";
export {
  assertBanIsAlwaysOrgScoped,
  assertValidModerationActionDuration,
  assertValidModerationActionScope,
} from "./domain/moderationActionRules";

// --- Infra (R2 evidence-attachment adapter boundary) ---
export { initiateEvidenceUpload } from "./application/initiateEvidenceUpload";
export type { InitiateEvidenceUploadInput, InitiatedEvidenceUpload } from "./application/initiateEvidenceUpload";
export { cloudflareR2Adapter, presignS3PutUrl } from "./infra/cloudflareR2Client";
export type { EvidenceAttachmentStorageAdapter, PresignedPutUrl } from "./infra/cloudflareR2Client";

export {
  PersonNotFoundError,
  SelfReportNotAllowedError,
  UnsupportedReportedEntityTypeError,
  ReportedEntityNotFoundError,
  ReportNotFoundError,
  InvalidReportStatusTransitionError,
  OutOfScopeError,
  NotClaimHolderError,
  ModerationActionNotFoundError,
  InvalidScopeError,
  InvalidDurationForActionTypeError,
  BanMustBeOrgScopedError,
  ModerationActionNotActiveError,
  ExternalServiceNotConfiguredError,
} from "./domain/errors";
