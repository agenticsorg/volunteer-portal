/**
 * Domain errors for the `training` bounded context's Course, Module, Video,
 * Enrollment, Quiz, and Certificate aggregates (docs/ddd/training-learning.md).
 * Thrown by the use cases under `application/`; caught at the (future) tRPC
 * procedure boundary (`server/api/routers/training.ts`) and translated to
 * the appropriate `TRPCError` code there — this module itself has no
 * knowledge of tRPC, same split as `modules/identity/domain/errors.ts` and
 * `modules/volunteering/domain/errors.ts`.
 */

/** A `can()` (ADR-0007) check denied the caller's requested action. */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/** No `training.course` row exists for the given id. */
export class CourseNotFoundError extends Error {
  constructor(courseId: string) {
    super(`No course found for id "${courseId}".`);
    this.name = "CourseNotFoundError";
  }
}

/** No `training.module` row exists for the given id (optionally scoped to a course). */
export class ModuleNotFoundError extends Error {
  constructor(moduleId: string) {
    super(`No module found for id "${moduleId}".`);
    this.name = "ModuleNotFoundError";
  }
}

/** AddModule precondition: every `prerequisiteModuleIds` entry must belong to the same course. */
export class ModuleNotInCourseError extends Error {
  constructor(moduleId: string, courseId: string) {
    super(`Module "${moduleId}" does not belong to course "${courseId}".`);
    this.name = "ModuleNotInCourseError";
  }
}

/**
 * AddModule precondition (docs/ddd/training-learning.md, Key Use Case 2):
 * "rejects cycles in the prerequisite graph." Checked by walking the DAG
 * `prerequisiteModuleIds` would extend, before the edges are persisted.
 */
export class ModulePrerequisiteCycleError extends Error {
  constructor(moduleId: string) {
    super(`Adding the requested prerequisites to module "${moduleId}" would create a dependency cycle.`);
    this.name = "ModulePrerequisiteCycleError";
  }
}

/** No `training.video` row exists for the given id. */
export class VideoNotFoundError extends Error {
  constructor(videoId: string) {
    super(`No video found for id "${videoId}".`);
    this.name = "VideoNotFoundError";
  }
}

/** GetPlaybackUrl / ApproveCaptions precondition: the Video must be `encodeStatus = 'ready'`. */
export class VideoNotReadyError extends Error {
  constructor(videoId: string, encodeStatus: string) {
    super(`Video "${videoId}" is not ready to play or caption (encodeStatus is "${encodeStatus}").`);
    this.name = "VideoNotReadyError";
  }
}

/**
 * ApproveCaptions precondition: a Video's `captionStatus` may only be
 * approved from `auto_generated` or `human_review` — never directly from
 * `pending` (no draft exists yet to review) and never re-approved once
 * already `approved`.
 */
export class CaptionsNotApprovableError extends Error {
  constructor(videoId: string, captionStatus: string) {
    super(`Video "${videoId}" captions are "${captionStatus}" and cannot be approved from this state.`);
    this.name = "CaptionsNotApprovableError";
  }
}

/**
 * PublishCourse invariant (docs/ddd/training-learning.md, Course invariant
 * 3 / ADR-0010's mandatory publish gate): zero Modules, or any Module's
 * Video with `captionStatus != 'approved'`. No code path may bypass this.
 */
export class CourseNotPublishableError extends Error {
  constructor(courseId: string, reason: string) {
    super(`Course "${courseId}" cannot be published: ${reason}`);
    this.name = "CourseNotPublishableError";
  }
}

/** A transition was attempted from a status the Course state machine does not allow it from. */
export class InvalidCourseTransitionError extends Error {
  constructor(courseId: string, from: string, to: string) {
    super(`Course "${courseId}" cannot transition from "${from}" to "${to}".`);
    this.name = "InvalidCourseTransitionError";
  }
}

/** AddModule precondition (Quiz invariant 4): every Question needs >= 1 Choice flagged `isCorrect`. */
export class QuizQuestionMissingCorrectChoiceError extends Error {
  constructor(prompt: string) {
    super(`Quiz question "${prompt}" must have at least one choice flagged as correct.`);
    this.name = "QuizQuestionMissingCorrectChoiceError";
  }
}

/** AddModule precondition (Quiz invariant 4): `passingScorePercent` must be between 1 and 100. */
export class QuizPassingScoreInvalidError extends Error {
  constructor() {
    super("A quiz's passingScorePercent must be between 1 and 100.");
    this.name = "QuizPassingScoreInvalidError";
  }
}

/** InitiateVideoUpload precondition: the Module must not already have a Video row. */
export class VideoAlreadyInitiatedError extends Error {
  constructor(moduleId: string) {
    super(`Module "${moduleId}" already has a video upload in progress or completed.`);
    this.name = "VideoAlreadyInitiatedError";
  }
}

/** ApproveCaptions precondition: `transcriptText` must be non-empty. */
export class TranscriptTextRequiredError extends Error {
  constructor() {
    super("Approving captions requires non-empty transcriptText.");
    this.name = "TranscriptTextRequiredError";
  }
}

/** No `training.enrollment` row exists for the given id. */
export class EnrollmentNotFoundError extends Error {
  constructor(enrollmentId: string) {
    super(`No enrollment found for id "${enrollmentId}".`);
    this.name = "EnrollmentNotFoundError";
  }
}

/**
 * EnrollInCourse invariant (Enrollment invariant 1): exactly one **active**
 * Enrollment per `(personId, courseId)` — the `uq_enrollment_active_person_course`
 * partial unique index is the real concurrency backstop, same "pre-check +
 * unique-constraint backstop" shape used throughout this codebase.
 */
export class DuplicateActiveEnrollmentError extends Error {
  constructor(personId: string, courseId: string) {
    super(`Person "${personId}" already has an active enrollment in course "${courseId}".`);
    this.name = "DuplicateActiveEnrollmentError";
  }
}

/** EnrollInCourse precondition: the Course must be `published`. */
export class CourseNotPublishedError extends Error {
  constructor(courseId: string) {
    super(`Course "${courseId}" is not published.`);
    this.name = "CourseNotPublishedError";
  }
}

/**
 * RecordProgress / SubmitQuizAttempt / GetPlaybackUrl precondition: the
 * caller must hold an active (or completed) Enrollment in the Course the
 * targeted Module/Video/Quiz belongs to.
 */
export class NotEnrolledError extends Error {
  constructor(personId: string, courseId: string) {
    super(`Person "${personId}" has no active or completed enrollment in course "${courseId}".`);
    this.name = "NotEnrolledError";
  }
}

/**
 * Module invariant 2: a Module cannot be started (progress created/updated)
 * until all of its `ModulePrerequisite` modules are `completed` in that
 * learner's Enrollment.
 */
export class ModulePrerequisitesNotMetError extends Error {
  constructor(moduleId: string) {
    super(`Module "${moduleId}"'s prerequisite modules are not yet completed.`);
    this.name = "ModulePrerequisitesNotMetError";
  }
}

/** RecordProgress precondition: `resumePositionSeconds` cannot exceed the Video's `durationSeconds`. */
export class ResumePositionExceedsDurationError extends Error {
  constructor(moduleId: string) {
    super(`Resume position exceeds video duration for module "${moduleId}".`);
    this.name = "ResumePositionExceedsDurationError";
  }
}

/** RecordProgress precondition: `resumePositionSeconds >= 0` and `0 <= watchProgressPercent <= 100`. */
export class RecordProgressInputInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid RecordProgress input: ${reason}`);
    this.name = "RecordProgressInputInvalidError";
  }
}

/** No `training.quiz` row exists for the given id, or it is not attached to the given module. */
export class QuizNotFoundError extends Error {
  constructor(quizId: string) {
    super(`No quiz found for id "${quizId}".`);
    this.name = "QuizNotFoundError";
  }
}

/**
 * SubmitQuizAttempt precondition (Quiz invariant, `maxAttempts`): the
 * learner has already reached `Quiz.maxAttempts` attempts for this
 * Enrollment.
 */
export class QuizMaxAttemptsExceededError extends Error {
  constructor(quizId: string) {
    super(`Quiz "${quizId}" maximum attempts have already been used for this enrollment.`);
    this.name = "QuizMaxAttemptsExceededError";
  }
}

/**
 * SubmitQuizAttempt precondition: `answers` must supply exactly one Choice
 * per the Quiz's Questions, and every `questionId`/`choiceId` pair must be
 * a real, matching Question/Choice belonging to this Quiz.
 */
export class QuizAnswersInvalidError extends Error {
  constructor(quizId: string, reason: string) {
    super(`Quiz "${quizId}" attempt answers are invalid: ${reason}`);
    this.name = "QuizAnswersInvalidError";
  }
}

/** No `training.certificate` row exists for the given id. */
export class CertificateNotFoundError extends Error {
  constructor(certificateId: string) {
    super(`No certificate found for id "${certificateId}".`);
    this.name = "CertificateNotFoundError";
  }
}

/** IngestVideoWebhook precondition: the Cloudflare Stream webhook signature failed verification. */
export class WebhookSignatureInvalidError extends Error {
  constructor() {
    super("Cloudflare Stream webhook signature verification failed.");
    this.name = "WebhookSignatureInvalidError";
  }
}

/**
 * Thrown by the Cloudflare Stream / R2 adapters (`infra/`) when a required
 * environment variable is not set. Never thrown mid-network-call — checked
 * up front, before any request is attempted, so a missing credential fails
 * fast and loud rather than surfacing as an opaque network/auth error. Per
 * this phase's own brief: no code path may fake success or return mock
 * data when these credentials are absent.
 */
export class ExternalServiceNotConfiguredError extends Error {
  constructor(missingEnvVar: string, purpose: string) {
    super(`${purpose} requires the "${missingEnvVar}" environment variable, which is not set.`);
    this.name = "ExternalServiceNotConfiguredError";
  }
}

/** EnrollInCourse precondition: `personId` must resolve via `identity`'s Open Host Service read. */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}
