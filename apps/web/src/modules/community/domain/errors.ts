/**
 * Domain errors for the `community` bounded context (docs/ddd/
 * community-social.md). Thrown by the use cases under `application/`;
 * caught at the (future) tRPC procedure boundary
 * (`server/api/routers/community.ts`) and translated to the appropriate
 * `TRPCError` code there — this module itself has no knowledge of tRPC,
 * same split as every other module's `domain/errors.ts`.
 */

/** A `can()` (ADR-0007) check denied the caller's requested action. */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/** CreatePost/GiveKudos/CreateTeam/... precondition: the target Person must exist (per `identity.getPersonSummary`). */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}

/** No `community.post` row exists for the given id. */
export class PostNotFoundError extends Error {
  constructor(postId: string) {
    super(`No post found for id "${postId}".`);
    this.name = "PostNotFoundError";
  }
}

/**
 * CreatePost, Post invariant 1 (docs/ddd/community-social.md): either
 * `scopeType = 'org'` was requested without `org_admin` authority, or
 * `scopeType = 'chapter'` was requested with `scopeId` other than the
 * author's own `authorChapterId` (a member cannot post *into* a chapter
 * they don't belong to). Named `SCOPE_INVARIANT_VIOLATION` to match the API
 * Contract Sketch's own documented throw.
 */
export class ScopeInvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SCOPE_INVARIANT_VIOLATION";
  }
}

/** Kudos invariant 1: `fromPersonId <> toPersonId` — no self-kudos. */
export class SelfKudosNotAllowedError extends Error {
  constructor() {
    super("A person cannot give kudos to themselves.");
    this.name = "SelfKudosNotAllowedError";
  }
}

/** Kudos invariant 2: `achievementRefType`/`achievementRefId` are all-or-nothing. */
export class AchievementReferenceMismatchError extends Error {
  constructor() {
    super("achievementRefType and achievementRefId must be provided together, or not at all.");
    this.name = "AchievementReferenceMismatchError";
  }
}

/** No `community.team` row exists for the given id. */
export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`No team found for id "${teamId}".`);
    this.name = "TeamNotFoundError";
  }
}

/** Team invariant 1: `(chapterId, name)` is unique among `active` Teams. */
export class TeamNameTakenError extends Error {
  constructor(chapterId: string, name: string) {
    super(`An active team named "${name}" already exists in chapter "${chapterId}".`);
    this.name = "TeamNameTakenError";
  }
}

/** TeamMembership invariant 2: at most one open membership per `(teamId, personId)`. */
export class AlreadyTeamMemberError extends Error {
  constructor(teamId: string, personId: string) {
    super(`Person "${personId}" already has an open membership in team "${teamId}".`);
    this.name = "AlreadyTeamMemberError";
  }
}

/** No `community.mentorship` row exists for the given id. */
export class MentorshipNotFoundError extends Error {
  constructor(mentorshipId: string) {
    super(`No mentorship found for id "${mentorshipId}".`);
    this.name = "MentorshipNotFoundError";
  }
}

/** Mentorship invariant 1: `mentorPersonId <> menteePersonId`. */
export class SelfMentorshipNotAllowedError extends Error {
  constructor() {
    super("A person cannot mentor themselves.");
    this.name = "SelfMentorshipNotAllowedError";
  }
}

/**
 * Mentorship invariant 2: a mentee may have at most one open
 * (`requested`/`active`) Mentorship at a time. Named to match the API
 * Contract Sketch's own documented throw (`ALREADY_HAS_OPEN_MENTORSHIP`).
 */
export class AlreadyHasOpenMentorshipError extends Error {
  constructor(menteePersonId: string) {
    super(`Person "${menteePersonId}" already has an open mentorship as mentee.`);
    this.name = "ALREADY_HAS_OPEN_MENTORSHIP";
  }
}

/** AcceptMentorship precondition: `status` must be `requested`. */
export class MentorshipNotRequestedError extends Error {
  constructor(mentorshipId: string, status: string) {
    super(`Mentorship "${mentorshipId}" is "${status}", not "requested" — cannot accept.`);
    this.name = "MentorshipNotRequestedError";
  }
}

/** AcceptMentorship precondition: only the mentorship's own mentor may accept it. */
export class NotTheMentorError extends Error {
  constructor(mentorshipId: string) {
    super(`Caller is not the mentor on mentorship "${mentorshipId}".`);
    this.name = "NotTheMentorError";
  }
}

/**
 * A consumed external event referenced a source-context row (a badge
 * award, an hour entry, a course, a streak) that this handler could not
 * resolve via the owning context's own Open Host Service read — a
 * cross-context data-consistency problem, not a normal domain rejection.
 * Thrown rather than silently skipping the projection so the failure is
 * visible and the event is retried (per ADR-0009's at-least-once delivery
 * guarantee) rather than the feed silently missing an entry.
 */
export class SourceRecordNotFoundError extends Error {
  constructor(sourceType: string, sourceId: string) {
    super(`Could not resolve "${sourceType}" record "${sourceId}" via its owning context's Open Host Service read.`);
    this.name = "SourceRecordNotFoundError";
  }
}

/**
 * CreatePost/GiveKudos, this stage's own Phase 7 build item 5 (the
 * Community-side half of the Moderation enforcement check): the caller
 * currently holds an active `suspend` or `ban`
 * (`moderation.getActiveActionsForPerson`) covering the write's own
 * scope. Named to mirror `ScopeInvariantViolationError`'s "own `name`
 * matches a documented throw code" shape, for a future API layer's
 * `TRPCError` translation.
 */
export class ActiveModerationSanctionError extends Error {
  constructor(actionType: "suspend" | "ban") {
    super(`Caller has an active "${actionType}" moderation sanction covering this write's scope.`);
    this.name = "ACTIVE_MODERATION_SANCTION";
  }
}

/**
 * An R2-backed adapter call (docs/ddd/community-social.md's Attachment
 * value object; ADR-0011) requires an environment variable that is not
 * set in this environment. Thrown instead of faking success — see
 * `infra/cloudflareR2Client.ts`'s own header comment.
 */
export class ExternalServiceNotConfiguredError extends Error {
  constructor(missingEnvVar: string, purpose: string) {
    super(`${purpose} requires the "${missingEnvVar}" environment variable, which is not set.`);
    this.name = "ExternalServiceNotConfiguredError";
  }
}
