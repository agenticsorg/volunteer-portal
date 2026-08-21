/**
 * training bounded-context module — public interface.
 *
 * Training — video/course library, prerequisites, watch progress, quizzes,
 * certificates.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Phase 4 scope: the Course/Module/Video/Enrollment/Quiz/Certificate
 * aggregates and every Key Use Case from docs/ddd/training-learning.md,
 * gated through the shared `@volunteer-portal/authz` `can()` policy module
 * (ADR-0007) exactly the way `modules/identity` and `modules/volunteering`
 * gate their own privileged use cases. The Cloudflare Stream/R2 adapters
 * (`infra/`) are exported as interfaces + a default real implementation, so
 * application-layer use cases (and their tests) can inject a fake — no
 * Cloudflare credentials are required to exercise the domain logic. The
 * tRPC router (`server/api/routers/training.ts`) remains an empty stub —
 * wiring it up is a later stage's work, same split Phase 2/3 used.
 */

// --- Authoring ---
export { createCourse } from "./application/createCourse";
export type { CreateCourseInput, CreatedCourse } from "./application/createCourse";

export { addModule } from "./application/addModule";
export type {
  AddModuleInput,
  AddedModule,
  AddModuleQuizInput,
  AddModuleQuestionInput,
  AddModuleChoiceInput,
} from "./application/addModule";

export { initiateVideoUpload } from "./application/initiateVideoUpload";
export type { InitiateVideoUploadInput, InitiatedVideoUpload } from "./application/initiateVideoUpload";

export { ingestVideoWebhook } from "./application/ingestVideoWebhook";
export type { IngestVideoWebhookInput, CloudflareStreamWebhookPayload } from "./application/ingestVideoWebhook";

export { approveCaptions } from "./application/approveCaptions";
export type { ApproveCaptionsInput } from "./application/approveCaptions";

export { publishCourse } from "./application/publishCourse";
export type { PublishCourseInput, PublishedCourse } from "./application/publishCourse";

// --- Learner-facing ---
export { enrollInCourse } from "./application/enrollInCourse";
export type { EnrollInCourseInput, EnrolledCourse } from "./application/enrollInCourse";

export { recordProgress } from "./application/recordProgress";
export type { RecordProgressInput, RecordProgressResult } from "./application/recordProgress";

export { submitQuizAttempt } from "./application/submitQuizAttempt";
export type {
  SubmitQuizAttemptInput,
  SubmitQuizAttemptAnswerInput,
  SubmittedQuizAttempt,
} from "./application/submitQuizAttempt";

export { getVideoPlaybackUrl } from "./application/getVideoPlaybackUrl";
export type { GetVideoPlaybackUrlInput, VideoPlaybackUrl } from "./application/getVideoPlaybackUrl";

export { getMyEnrollment } from "./application/getMyEnrollment";
export type { EnrollmentWithProgress, ModuleProgressItem } from "./application/getMyEnrollment";

export { getCourseCatalog, getCourseById } from "./application/getCourseCatalog";
export type { CourseSummary, CourseDetail, ModuleSummary } from "./application/getCourseCatalog";

export { searchTraining } from "./application/searchTraining";
export type { SearchTrainingInput, TrainingSearchResult } from "./application/searchTraining";

export { getCertificate, listCertificatesForPerson } from "./application/getCertificate";
export type { CertificateDTO } from "./application/getCertificate";

/**
 * The Open Host Service query `volunteering`'s `hasCompletedRequiredTraining`
 * calls (replacing its Phase 3 stub) — see this function's own doc comment.
 */
export { hasCompletedRequiredCourses } from "./application/hasCompletedRequiredCourses";

// --- Adapter interfaces (for callers/tests that need to inject a fake) ---
export { cloudflareStreamAdapter } from "./infra/cloudflareStreamClient";
export type { CloudflareStreamAdapter } from "./infra/cloudflareStreamClient";
export { cloudflareR2Adapter, signS3PutRequest } from "./infra/cloudflareR2Client";
export type { CertificateStorageAdapter, SignedS3PutRequest } from "./infra/cloudflareR2Client";
export { buildCertificatePdf } from "./infra/certificatePdf";
export type { CertificateTemplateInput } from "./infra/certificatePdf";

/** Pure prerequisite-DAG cycle detection (`addModule` uses this internally) — exported for direct unit testing. */
export { wouldCreateCycle } from "./domain/prerequisiteGraph";
export type { PrerequisiteEdges } from "./domain/prerequisiteGraph";

/** Pure caption-approval publish-gate predicate (`publishCourse` uses this internally) — exported for direct unit testing. */
export { isCoursePublishable, findCaptionGateBlocker } from "./domain/captionGate";
export type { ModuleCaptionState } from "./domain/captionGate";

/** Pure module/course-completion predicates (`moduleCompletion` uses these internally) — exported for direct unit testing. */
export { isModuleReadyToComplete, isCourseReadyToComplete } from "./domain/moduleCompletionRule";

export {
  ForbiddenActionError,
  CourseNotFoundError,
  ModuleNotFoundError,
  ModuleNotInCourseError,
  ModulePrerequisiteCycleError,
  VideoNotFoundError,
  VideoNotReadyError,
  CaptionsNotApprovableError,
  CourseNotPublishableError,
  InvalidCourseTransitionError,
  QuizQuestionMissingCorrectChoiceError,
  QuizPassingScoreInvalidError,
  VideoAlreadyInitiatedError,
  TranscriptTextRequiredError,
  EnrollmentNotFoundError,
  DuplicateActiveEnrollmentError,
  CourseNotPublishedError,
  NotEnrolledError,
  ModulePrerequisitesNotMetError,
  ResumePositionExceedsDurationError,
  RecordProgressInputInvalidError,
  QuizNotFoundError,
  QuizMaxAttemptsExceededError,
  QuizAnswersInvalidError,
  CertificateNotFoundError,
  WebhookSignatureInvalidError,
  ExternalServiceNotConfiguredError,
  PersonNotFoundError,
} from "./domain/errors";
