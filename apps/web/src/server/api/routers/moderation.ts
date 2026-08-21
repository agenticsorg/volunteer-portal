/**
 * moderation bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `moderation`, per
 * ADR-0003. Procedures are thin adapters over `modules/moderation/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; every scope-authority
 * or ownership `can()` check (ADR-0007) that gates a *mutation* already
 * happens inside the use case itself (via `listActiveRoleAssignments` +
 * `can()`, exactly like `report.claim`/`moderation_action.take` etc. in
 * `packages/authz/src/rules.ts`). This file's own job is: validate input,
 * resolve the caller's `PolicySubject`/`personId` from the *verified*
 * session (never from client input — same anti-corruption discipline as
 * `identityRouter`/`communityRouter`/`trainingRouter`), translate domain
 * errors to `TRPCError` codes, and — for `queryModerationHistory` only —
 * apply the one `can()` check this router performs directly (see that
 * procedure's own doc comment, and `trainingRouter.getCertificate`'s
 * identical "read has no opinion of its own on who may call it" precedent).
 *
 * There is no `moderatorProcedure` builder in this codebase (see
 * `../trpc.ts` — only `publicProcedure`/`sessionProcedure`/
 * `protectedProcedure` exist); the API Contract Sketch's own
 * `moderatorProcedure` maps onto plain `protectedProcedure` here, same as
 * `gamificationRouter`'s own header already documents for the absent
 * `adminProcedure`. Authority is enforced by the use case's own `can()`
 * call, not by a router-level role gate.
 *
 * Shaped per the API Contract Sketch in docs/ddd/moderation-trust-safety.md,
 * kept flat (not split into `moderationRouter` + `moderationModeratorRouter`
 * sub-modules the sketch sketches as two separate router files) — mounted
 * as one `moderation` sub-router on the root `appRouter`, same "one
 * sub-router per bounded context" shape every other module's own router
 * file already follows (`../root.ts`'s own header). A few deliberate
 * deviations from the sketch's own TypeScript block, each documented at its
 * own procedure below:
 *
 * - `listReportQueue` is deliberately NOT included: this stage's own Build
 *   list (docs/plans/implementation-plan.md, Phase 7) names exactly four
 *   API surfaces to build — file report, review report (claim/release/
 *   resolve/dismiss), issue enforcement action (take/revoke), and query
 *   history — and no `listReportQueue` (or equivalent) application-layer
 *   query exists under `modules/moderation/application/` for this router to
 *   adapt. Same "don't invent application-layer functionality this stage
 *   wasn't asked to build" precedent `communityRouter`'s own header sets for
 *   omitting `completeMentorship`.
 * - `initiateEvidenceUpload` — the sketch's own `fileReport` takes
 *   `evidenceAttachments` as already-known `{r2ObjectKey, ...}` values,
 *   implying a prior upload step it doesn't spell out. Without this
 *   mutation no client could ever obtain a real `r2ObjectKey` to pass to
 *   `fileReport` — same "upload triggers the write, not vice versa" shape
 *   `communityRouter.initiatePostAttachmentUpload`/
 *   `trainingRouter.initiateVideoUpload` fill for their own attachments.
 * - `queryModerationHistory` — not in the sketch's own TypeScript block (it
 *   is described only in the doc's Integration & Anti-Corruption Notes as
 *   an Open Host Service function `admin` will call in-process, once the
 *   Admin & Reporting phase exists), but this stage's own instructions
 *   explicitly name "query history" as one of the four API surfaces to
 *   build, and no `admin` module exists yet for it to be called from
 *   in-process. Exposed here as a moderator-only tRPC procedure so a
 *   moderator-facing UI has a real way to reach it today; `admin`'s own
 *   future in-process call into `modules/moderation/index.ts` directly is
 *   unaffected by this router also existing.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import {
  fileReport,
  claimReport,
  releaseReportClaim,
  resolveReport,
  dismissReport,
  takeModerationAction,
  revokeModerationAction,
  getActiveActionsForPerson,
  queryModerationHistory,
  initiateEvidenceUpload,
  REPORTED_ENTITY_TYPES,
  REPORT_REASONS,
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
} from "@/modules/moderation";
import { listActiveRoleAssignments } from "@/modules/identity";
import { router, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

/** Builds the `PolicySubject` every privileged use case's `caller` argument needs, from the already-resolved session `Person` — same helper as every other router's own `callerSubject`. */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * The scope pair `takeModerationAction` and `queryModerationHistory` share
 * — mirrors `moderation.moderation_action`'s own `CHECK ((scope_type =
 * 'org') = (scope_id IS NULL))`, same reusable shape as
 * `communityRouter`'s own `scopePairSchema`. Rejected by zod before the
 * resolver runs.
 */
const scopePairSchema = z
  .object({
    scopeType: z.enum(["org", "chapter"]),
    scopeId: ulidSchema.nullable(),
  })
  .refine((value) => (value.scopeType === "org") === (value.scopeId === null), {
    message: "scopeId must be null when scopeType is 'org', and a chapter id when scopeType is 'chapter'.",
  });

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/moderation/application/`) to the appropriate `TRPCError` code.
 * Centralized here, same shape as every other router's own `map*Error`.
 */
function mapModerationError(error: unknown): never {
  if (error instanceof PersonNotFoundError || error instanceof ReportedEntityNotFoundError || error instanceof ReportNotFoundError || error instanceof ModerationActionNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (
    error instanceof SelfReportNotAllowedError ||
    error instanceof InvalidScopeError ||
    error instanceof InvalidDurationForActionTypeError ||
    error instanceof BanMustBeOrgScopedError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof UnsupportedReportedEntityTypeError) {
    // Not a bad request from the caller's own input (reportedEntityType is
    // a valid member of the closed set); it is this module not having a
    // content-snapshot read wired up yet for that type — see
    // `resolveReportedEntitySnapshot.ts`'s own doc comment.
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: error.message });
  }
  if (
    error instanceof InvalidReportStatusTransitionError ||
    error instanceof ModerationActionNotActiveError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (error instanceof OutOfScopeError || error instanceof NotClaimHolderError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (error instanceof ExternalServiceNotConfiguredError) {
    // A missing R2 env var is an ops/config problem, not a bad request —
    // surface the exact missing-var message (this environment's documented
    // "throw a clear not-configured error" contract) rather than tRPC's
    // generic masked 500. Same precedent as `communityRouter`'s own mapper.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  }
  throw error;
}

export const moderationRouter = router({
  // --- Reports (every registered volunteer) ---
  fileReport: protectedProcedure
    .input(
      z.object({
        reportedEntityType: z.enum(REPORTED_ENTITY_TYPES),
        reportedEntityId: ulidSchema,
        reason: z.enum(REPORT_REASONS),
        reasonDetail: z.string().max(2000).optional(),
        evidenceAttachments: z
          .array(
            z.object({
              r2ObjectKey: z.string(),
              contentType: z.string(),
              sizeBytes: z.number().int().positive(),
            }),
          )
          .max(6)
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await fileReport(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  /** See this file's header — the upload half of `fileReport`'s EvidenceAttachment value object (ADR-0011), not in the sketch's own TypeScript block but required for any real `r2ObjectKey` to exist. */
  initiateEvidenceUpload: protectedProcedure
    .input(z.object({ fileExtension: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await initiateEvidenceUpload({ caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  /**
   * `getMyActiveActions` — a volunteer's own current sanctions, for
   * self-service transparency (API Contract Sketch). `getActiveActionsForPerson`
   * itself requires a `scope` (an org-wide action always applies; a
   * chapter-scoped one only applies within that exact chapter — see its
   * own doc comment), so "my active actions" queries at the caller's own
   * `primaryChapterId` (falling back to `org` scope when the caller has
   * none), the same scope `community.createPost` would check for a write
   * this caller made into their own chapter today — this surfaces every
   * `active` sanction that could actually restrict this caller right now,
   * not a hypothetical action scoped to some other chapter they have no
   * membership in.
   */
  getMyActiveActions: protectedProcedure.query(({ ctx }) =>
    getActiveActionsForPerson(ctx.prisma, ctx.person.personId, {
      scopeType: ctx.person.primaryChapterId ? "chapter" : "org",
      scopeId: ctx.person.primaryChapterId,
    }),
  ),

  // --- Report review (moderator authority enforced inside each use case) ---
  claimReport: protectedProcedure
    .input(z.object({ reportId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await claimReport(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  releaseReportClaim: protectedProcedure
    .input(z.object({ reportId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await releaseReportClaim(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  resolveReport: protectedProcedure
    .input(
      z.object({
        reportId: ulidSchema,
        resolutionActionId: ulidSchema.optional(),
        resolutionNotes: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveReport(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  dismissReport: protectedProcedure
    .input(z.object({ reportId: ulidSchema, resolutionNotes: z.string().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await dismissReport(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  // --- Enforcement ladder (moderator authority enforced inside each use case) ---
  takeModerationAction: protectedProcedure
    .input(
      scopePairSchema.and(
        z.object({
          targetPersonId: ulidSchema,
          actionType: z.enum(["warn", "mute", "suspend", "ban"]),
          reason: z.string().min(1).max(2000),
          endsAt: z.string().datetime().nullable().optional(),
          relatedReportId: ulidSchema.optional(),
        }),
      ),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await takeModerationAction(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  revokeModerationAction: protectedProcedure
    .input(z.object({ actionId: ulidSchema, revokeReason: z.string().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokeModerationAction(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapModerationError(error);
      }
    }),

  /**
   * `queryModerationHistory` — see this file's header for why it's
   * included despite not being in the sketch's own TypeScript block.
   * `queryModerationHistory`'s own doc comment is explicit that it "carries
   * no `can()` gate itself ... that authorization belongs at the calling
   * procedure/router layer" — this is that layer, same direct-`can()`-in-
   * the-router shape `trainingRouter.getCertificate` already establishes
   * for a read its own use case doesn't gate.
   *
   * Scope-authority test reuses `report.claim`'s own rule
   * (`hasModerationAuthorityForScope` in `packages/authz/src/rules.ts`) —
   * the identical "org_admin, global moderator, or chapter moderator scoped
   * to exactly this chapter" shape this query's own visibility needs,
   * rather than adding a new `Action` union member (and its own
   * `packages/authz` exhaustiveness-test entry) for what is structurally
   * the same authority check. `input.chapterId` filters to that one
   * chapter's history (chapter-scoped moderators may reach it); omitting
   * it requests unfiltered, org-wide history, which only an `org_admin` or
   * a `global`-scoped moderator may see — a chapter-scoped moderator
   * cannot use an absent `chapterId` (or a bare `personId`/`reportId`
   * filter) to see history outside their own chapter.
   */
  queryModerationHistory: protectedProcedure
    .input(
      z.object({
        personId: ulidSchema.optional(),
        chapterId: ulidSchema.optional(),
        reportId: ulidSchema.optional(),
        cursor: ulidSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const assignments = await listActiveRoleAssignments(ctx.prisma, ctx.person.personId);
      const allowed = can(
        callerSubject(ctx.person),
        "report.claim",
        input.chapterId
          ? { type: "moderation_history", scopeType: "chapter", scopeId: input.chapterId }
          : { type: "moderation_history", scopeType: "global", scopeId: null },
        assignments,
      );
      if (!allowed) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not authorized to query moderation history at this scope." });
      }

      return queryModerationHistory(ctx.prisma, input);
    }),
});
