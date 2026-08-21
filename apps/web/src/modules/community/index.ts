/**
 * community bounded-context module — public interface.
 *
 * Community — activity feed, teams/guilds, kudos/peer recognition, member directory.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 6 scope, this stage: the domain/application layer only — every
 * aggregate/invariant and Key Use Case from docs/ddd/community-social.md
 * this stage's Build list calls for (Post, FeedEntry, Kudos, Team,
 * TeamMembership, Mentorship), gated through `@volunteer-portal/authz`'s
 * `can()` (ADR-0007) where the doc specifies it (`post.create_org_scope`
 * only — Post invariant 1; every other mutation here has no `can()` gate
 * of its own, matching the API Contract Sketch's plain `protectedProcedure`
 * shape), Person data resolved only via `identity.getPersonSummary`, and
 * consuming `gamification`/`volunteering`/`training`'s domain events
 * idempotently per ADR-0009 (`consumeInboundEvent`, keyed by
 * `community.processed_events` — see that table's own Prisma-schema
 * comment for why it doesn't call `packages/outbox`'s `drainOutbox()`
 * unmodified, same precedent as `gamification`'s own consumer).
 *
 * FeedEntry's hard behavioral split (this stage's own completion bar) is
 * implemented exactly as documented: native `kind = 'post'` entries are a
 * thin pointer resolved by a live join against `community.post` at read
 * time (`getChapterFeed`/`getOrgFeed`, via the private `feedRead.ts`), so a
 * Post edit/hide propagates automatically; every other `kind` is an
 * immutable snapshot written once by its own `handle*` event consumer and
 * never re-read from its source context again.
 *
 * Deliberately NOT in this stage (a later stage's job, or explicitly out
 * of this stage's Build list): the tRPC router
 * (`server/api/routers/community.ts` stays an empty stub for now, same
 * split as every other module) and the graphile-worker task that drains
 * `gamification.domain_events`/`volunteering.domain_events`/
 * `training.domain_events` and calls `consumeInboundEvent` per row (apps/worker
 * infra); `HandlePersonAnonymized` and `HandleModerationActionTaken`
 * (Build item 2 names exactly `BadgeAwarded`/`HoursApproved`/
 * `CourseCompleted`/`StreakExtended` — `moderation` doesn't exist yet, and
 * the erasure fan-out is a separate, cross-module concern); `LeaveTeam`,
 * `CompleteMentorship`/`DeclineMentorship`/`CancelMentorship`, and
 * `RebuildFeedProjection` (Build item 5 names exactly "Team
 * creation/joining and the Mentorship request-accept lifecycle").
 */

// --- Inbound event consumption (ADR-0009) ---
export { consumeInboundEvent } from "./application/consumeInboundEvent";
export type { ConsumeInboundEventResult } from "./application/consumeInboundEvent";
export { handleBadgeAwarded } from "./application/handleBadgeAwarded";
export { handleHoursApproved } from "./application/handleHoursApproved";
export { handleCourseCompleted } from "./application/handleCourseCompleted";
export { handleStreakExtended } from "./application/handleStreakExtended";
export type { ProjectionResult } from "./application/idempotentProjection";
export {
  INBOUND_EVENT_TYPES,
  isInboundEventType,
  sourceContextForEventType,
} from "./domain/inboundEvents";
export type {
  InboundEvent,
  InboundEventType,
  BadgeAwardedPayload,
  HoursApprovedPayload,
  CourseCompletedPayload,
  StreakExtendedPayload,
} from "./domain/inboundEvents";

/** `HandleStreakExtended`'s milestone filter — exported for direct unit testing. */
export { STREAK_MILESTONE_LENGTHS, isMilestoneStreakLength } from "./domain/streakMilestones";

// --- Posts ---
export { createPost } from "./application/createPost";
export type { CreatePostInput, CreatedPost, PostAttachmentInput } from "./application/createPost";

export { getPostSnapshot } from "./application/getPostSnapshot";
export type { PostSnapshot } from "./application/getPostSnapshot";

export { initiatePostAttachmentUpload } from "./application/initiatePostAttachmentUpload";
export type {
  InitiatePostAttachmentUploadInput,
  InitiatedPostAttachmentUpload,
} from "./application/initiatePostAttachmentUpload";

// --- Feed (two real, distinct query paths — never mixed) ---
export { getChapterFeed } from "./application/getChapterFeed";
export type { GetChapterFeedInput } from "./application/getChapterFeed";

export { getOrgFeed } from "./application/getOrgFeed";
export type { FeedEntryDTO, FeedPage, FeedPagination } from "./application/feedRead";

// --- Kudos ---
export { giveKudos } from "./application/giveKudos";
export type { GiveKudosInput, GivenKudos } from "./application/giveKudos";

export { getKudosReceived } from "./application/getKudosReceived";
export type { KudosDTO, GetKudosReceivedInput } from "./application/getKudosReceived";

// --- Teams ---
export { createTeam } from "./application/createTeam";
export type { CreateTeamInput, CreatedTeam } from "./application/createTeam";

export { joinTeam } from "./application/joinTeam";
export type { JoinTeamInput, JoinedTeam } from "./application/joinTeam";

// --- Mentorship ---
export { requestMentorship } from "./application/requestMentorship";
export type { RequestMentorshipInput, RequestedMentorship } from "./application/requestMentorship";

export { acceptMentorship } from "./application/acceptMentorship";
export type { AcceptMentorshipInput, AcceptedMentorship } from "./application/acceptMentorship";

// --- Infra (R2 attachment adapter boundary) ---
export { cloudflareR2Adapter, presignS3PutUrl } from "./infra/cloudflareR2Client";
export type { PostAttachmentStorageAdapter, PresignedPutUrl } from "./infra/cloudflareR2Client";

export {
  ForbiddenActionError,
  PersonNotFoundError,
  PostNotFoundError,
  ScopeInvariantViolationError,
  SelfKudosNotAllowedError,
  AchievementReferenceMismatchError,
  TeamNotFoundError,
  TeamNameTakenError,
  AlreadyTeamMemberError,
  MentorshipNotFoundError,
  SelfMentorshipNotAllowedError,
  AlreadyHasOpenMentorshipError,
  MentorshipNotRequestedError,
  NotTheMentorError,
  SourceRecordNotFoundError,
  ExternalServiceNotConfiguredError,
} from "./domain/errors";
