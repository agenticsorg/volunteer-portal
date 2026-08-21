/**
 * training bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `training`, per
 * ADR-0003. Procedures are thin adapters over `modules/training/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; every `can()` check
 * (ADR-0007) happens inside the use case itself (via
 * `assertTrainingAuthority`), using the caller's own
 * `identity.role_assignments` (fetched via `listActiveRoleAssignments`).
 * This file's own job is: validate input, resolve the caller's
 * `PolicySubject`/`personId` from the *verified* session (never from
 * client input — same anti-corruption discipline as `identityRouter`/
 * `volunteeringRouter`), translate domain errors to `TRPCError` codes,
 * and — for `getCertificate` only — apply the one ownership/`can()` check
 * this router performs directly (see that procedure's own doc comment).
 *
 * Shaped per the API Contract Sketch in docs/ddd/training-learning.md,
 * kept flat (not grouped into `courses`/`modules`/... sub-routers) to
 * mirror that sketch's own procedure names as closely as possible — same
 * "flat where the sketch is flat" precedent `identityRouter` sets for its
 * ungrouped Person procedures (`register`, `getPersonSummary`, `me`).
 * A few procedures beyond the sketch's own list are included because the
 * Build list ("courses, modules, videos, enrollment, quizzes,
 * certificates") and the module's own exported use cases require them to
 * reach a working end-to-end surface — each documented at its own
 * declaration below:
 *
 * - `initiateVideoUpload` — the sketch's own Integration Notes describe
 *   Video ingestion, but the mutation itself isn't in the sketch's
 *   TypeScript block. Without it no Module can ever get a real Video row
 *   (`training.video.cloudflare_stream_id` is `NOT NULL UNIQUE`).
 * - `getCourseById` — the catalog needs a course detail read (modules,
 *   sequence, prerequisites, quiz shape) beyond `getCourseCatalog`'s
 *   summary list.
 * - `getVideoPlaybackUrl` — ADR-0010's mandatory signed-URL gate; without
 *   it no enrolled learner can ever actually play a video.
 * - `listMyCertificates` — the self-service list a learner's "my
 *   certificates" page needs; `getCertificate` alone only fetches one by
 *   id.
 * - `search` — ADR-0017 full-text search, explicitly called out as build
 *   item 3 ("Course/module/transcript full-text search using the tsvector
 *   column"), same sibling-to-the-sketch shape as
 *   `volunteeringRouter.opportunities.search`.
 *
 * The Cloudflare Stream webhook (`POST /api/v1/webhooks/cloudflare-stream`)
 * is deliberately NOT a procedure here — Cloudflare cannot call tRPC's
 * batched transport, so it's a plain REST route
 * (`app/api/v1/webhooks/cloudflare-stream/route.ts`) that calls straight
 * into `ingestVideoWebhook`.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import {
  createCourse,
  addModule,
  initiateVideoUpload,
  approveCaptions,
  publishCourse,
  enrollInCourse,
  recordProgress,
  submitQuizAttempt,
  getVideoPlaybackUrl,
  getMyEnrollment,
  getCourseCatalog,
  getCourseById,
  searchTraining,
  getCertificate,
  listCertificatesForPerson,
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
  ExternalServiceNotConfiguredError,
  PersonNotFoundError,
} from "@/modules/training";
import { listActiveRoleAssignments } from "@/modules/identity";
import { router, publicProcedure, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

/** Builds the `PolicySubject` every privileged use case's `caller` argument needs, from the already-resolved session `Person` — never a bare `{ id }` (see `PolicySubject`'s own doc comment on why `status` is required). */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/training/application/`) to the appropriate `TRPCError` code.
 * Centralized here, same shape as `identityRouter`'s `mapIdentityError`
 * and `volunteeringRouter`'s `mapVolunteeringError`.
 */
function mapTrainingError(error: unknown): never {
  if (error instanceof ForbiddenActionError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (
    error instanceof CourseNotFoundError ||
    error instanceof ModuleNotFoundError ||
    error instanceof VideoNotFoundError ||
    error instanceof EnrollmentNotFoundError ||
    error instanceof QuizNotFoundError ||
    error instanceof CertificateNotFoundError ||
    error instanceof PersonNotFoundError
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (
    error instanceof DuplicateActiveEnrollmentError ||
    error instanceof VideoAlreadyInitiatedError ||
    error instanceof ModulePrerequisiteCycleError ||
    error instanceof CaptionsNotApprovableError ||
    error instanceof InvalidCourseTransitionError ||
    error instanceof QuizMaxAttemptsExceededError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (
    error instanceof ModuleNotInCourseError ||
    error instanceof QuizQuestionMissingCorrectChoiceError ||
    error instanceof QuizPassingScoreInvalidError ||
    error instanceof TranscriptTextRequiredError ||
    error instanceof ResumePositionExceedsDurationError ||
    error instanceof RecordProgressInputInvalidError ||
    error instanceof QuizAnswersInvalidError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (
    error instanceof CourseNotPublishableError ||
    error instanceof CourseNotPublishedError ||
    error instanceof VideoNotReadyError ||
    error instanceof NotEnrolledError ||
    error instanceof ModulePrerequisitesNotMetError
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  }
  if (error instanceof ExternalServiceNotConfiguredError) {
    // A missing Cloudflare env var is an ops/config problem, not a bad
    // request — surface the exact missing-var message (this environment's
    // documented "throw a clear not-configured error" contract) rather
    // than tRPC's generic masked 500.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  }
  throw error;
}

const addModuleChoiceInputSchema = z.object({
  label: z.string().min(1),
  isCorrect: z.boolean(),
});

const addModuleQuestionInputSchema = z.object({
  prompt: z.string().min(1),
  choices: z.array(addModuleChoiceInputSchema).min(1),
});

const addModuleQuizInputSchema = z.object({
  passingScorePercent: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().positive().optional(),
  questions: z.array(addModuleQuestionInputSchema).min(1),
});

export const trainingRouter = router({
  // --- Authoring ---
  createCourse: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        passingCertificateEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCourse(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  addModule: protectedProcedure
    .input(
      z.object({
        courseId: ulidSchema,
        title: z.string().min(1),
        sequence: z.number().int().positive(),
        isRequired: z.boolean().default(true),
        prerequisiteModuleIds: z.array(ulidSchema).default([]),
        quiz: addModuleQuizInputSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await addModule(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  /** See this file's header — the Ingestion half of ADR-0010, not in the sketch's own TypeScript block but required for any Video row to exist. */
  initiateVideoUpload: protectedProcedure
    .input(z.object({ moduleId: ulidSchema, maxDurationSeconds: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await initiateVideoUpload(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  approveCaptions: protectedProcedure
    .input(z.object({ videoId: ulidSchema, transcriptText: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await approveCaptions(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
        return { captionStatus: "approved" as const };
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  publishCourse: protectedProcedure
    .input(z.object({ courseId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await publishCourse(ctx.prisma, { caller: callerSubject(ctx.person), courseId: input.courseId });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  // --- Learner-facing ---
  enrollInCourse: protectedProcedure
    .input(z.object({ courseId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await enrollInCourse(ctx.prisma, { personId: ctx.person.personId, courseId: input.courseId });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  recordProgress: protectedProcedure
    .input(
      z.object({
        enrollmentId: ulidSchema,
        moduleId: ulidSchema,
        resumePositionSeconds: z.number().int().nonnegative(),
        watchProgressPercent: z.number().int().min(0).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordProgress(ctx.prisma, { personId: ctx.person.personId, ...input });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  submitQuizAttempt: protectedProcedure
    .input(
      z.object({
        enrollmentId: ulidSchema,
        quizId: ulidSchema,
        answers: z.array(z.object({ questionId: ulidSchema, choiceId: ulidSchema })).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitQuizAttempt(ctx.prisma, { personId: ctx.person.personId, ...input });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  /** ADR-0010's mandatory signed-URL gate — not in the sketch's own block but required for any enrolled learner to actually play a video. */
  getVideoPlaybackUrl: protectedProcedure
    .input(z.object({ videoId: ulidSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getVideoPlaybackUrl(ctx.prisma, { caller: callerSubject(ctx.person), videoId: input.videoId });
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  getMyEnrollment: protectedProcedure
    .input(z.object({ courseId: ulidSchema }))
    .query(({ ctx, input }) => getMyEnrollment(ctx.prisma, ctx.person.personId, input.courseId)),

  // --- Public reads ---
  getCourseCatalog: publicProcedure
    .input(z.object({ status: z.literal("published").default("published") }))
    .query(({ ctx, input }) => getCourseCatalog(ctx.prisma, input.status)),

  /** Course detail (ordered modules, prerequisites, video/quiz shape) — beyond `getCourseCatalog`'s summary list, needed for a course detail page. */
  getCourseById: publicProcedure
    .input(z.object({ courseId: ulidSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getCourseById(ctx.prisma, input.courseId);
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  /** ADR-0017 full-text search (build item 3) — see this file's header. */
  search: publicProcedure
    .input(z.object({ query: z.string().min(1), limit: z.number().int().max(50).optional() }))
    .query(({ ctx, input }) => searchTraining(ctx.prisma, input)),

  // --- Certificates ---
  /**
   * `getCertificate` — the sketch's own `getCertificate({ certificateId })
   * -> CertificateDTO` is `protectedProcedure` but, unlike every other
   * mutation/query above, `getCertificate`'s own use case takes no
   * `caller` and performs no authorization of its own (a plain
   * `findUnique` by id — same "read has no opinion on who may call it"
   * shape as `volunteering`'s `queryApprovedHours`). This router is the
   * one place that authorization belongs, exactly like
   * `volunteeringRouter.hourEntries.exportApproved`'s own direct `can()`
   * check: the certificate's own holder (`certificate.personId ===
   * ctx.person.personId`) may always read it, or a caller holding
   * `course.manage` authority (`content_admin`/`org_admin`) may read any
   * certificate for verification/support purposes.
   */
  getCertificate: protectedProcedure
    .input(z.object({ certificateId: ulidSchema }))
    .query(async ({ ctx, input }) => {
      try {
        const certificate = await getCertificate(ctx.prisma, input.certificateId);

        if (certificate.personId !== ctx.person.personId) {
          const assignments = await listActiveRoleAssignments(ctx.prisma, ctx.person.personId);
          const caller = callerSubject(ctx.person);
          const allowed = can(caller, "course.manage", { type: "course", scopeType: "global", scopeId: null }, assignments);
          if (!allowed) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Not authorized to view this certificate." });
          }
        }

        return certificate;
      } catch (error) {
        mapTrainingError(error);
      }
    }),

  /** Self-service — every Certificate the caller holds, for a "my certificates" page. */
  listMyCertificates: protectedProcedure.query(({ ctx }) => listCertificatesForPerson(ctx.prisma, ctx.person.personId)),
});
