/**
 * community bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `community`, per
 * ADR-0003. Procedures are thin adapters over `modules/community/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; the one `can()` check
 * this context makes (`post.create_org_scope`, Post invariant 1) happens
 * inside `createPost` itself, not here. This file's own job is: validate
 * input, resolve the caller's `PolicySubject`/`personId` (and, for
 * `createPost`, `primaryChapterId`) from the *verified* session (never from
 * client input — same anti-corruption discipline as `identityRouter`/
 * `volunteeringRouter`/`trainingRouter`/`gamificationRouter`), and translate
 * domain errors to `TRPCError` codes.
 *
 * Shaped per the API Contract Sketch in docs/ddd/community-social.md, with
 * a few deliberate deviations/additions, each documented at its own
 * procedure below:
 *
 * - `getFeed` is one procedure, per the sketch, but dispatches internally
 *   to `getChapterFeed` or `getOrgFeed` — `modules/community`'s own two
 *   *distinct* query paths (never a single generic `queryFeedPage` entry
 *   point reachable from outside the module) — based on `input.scopeType`,
 *   validated by zod before either path is ever reached.
 * - `initiatePostAttachmentUpload` — the sketch's own `createPost` takes
 *   `attachments` as already-known `{r2ObjectKey, ...}` values, implying a
 *   prior upload step it doesn't spell out. Without this mutation no
 *   client could ever obtain a real `r2ObjectKey` to pass to `createPost`
 *   — same "upload triggers the write, not vice versa" shape
 *   `trainingRouter.initiateVideoUpload` fills for Video.
 * - `search` — ADR-0017 full-text search (Phase 6 build item 2), not in
 *   the sketch's own TypeScript block, same "sibling to the sketch" shape
 *   as `trainingRouter.search`/`volunteeringRouter.opportunities.search`.
 * - `completeMentorship` (the sketch's own Mentorship lifecycle mutation)
 *   is deliberately NOT included: `modules/community`'s own Build list this
 *   stage is scoped to "the Mentorship request-accept lifecycle" only (see
 *   `modules/community/index.ts`'s header) — no `completeMentorship`
 *   application-layer use case exists yet for this router to adapt.
 * - The sketch's separate `communityAdminRouter`/`rebuildFeedProjection`
 *   (an operational, not user-facing, procedure) is out of this stage's
 *   Build list for the same reason — no `rebuildFeedProjection` use case
 *   exists yet.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  createPost,
  initiatePostAttachmentUpload,
  getChapterFeed,
  getOrgFeed,
  searchPosts,
  giveKudos,
  getKudosReceived,
  createTeam,
  joinTeam,
  requestMentorship,
  acceptMentorship,
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
  ExternalServiceNotConfiguredError,
} from "@/modules/community";
import { router, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

/** Builds the `PolicySubject` `createPost`'s own `can()` check needs, from the already-resolved session `Person` — same helper as every other router's own `callerSubject`. */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * The scope pair every scope-bound procedure below shares
 * (docs/ddd/community-social.md's Scope definition: `scopeId` is required
 * iff `scopeType = 'chapter'`, `NULL` iff `scopeType = 'org'` — the same
 * `CHECK` the DB enforces on `community.post`/`community.feed_entry`).
 * Rejected by zod before any resolver runs, so a malformed request can
 * never reach `getChapterFeed`/`getOrgFeed`/`searchPosts` with a scope
 * that doesn't match one of those two real, distinct shapes.
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
 * `modules/community/application/`) to the appropriate `TRPCError` code.
 * Centralized here, same shape as every other router's own `map*Error`.
 */
function mapCommunityError(error: unknown): never {
  if (error instanceof ForbiddenActionError || error instanceof ScopeInvariantViolationError || error instanceof NotTheMentorError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (
    error instanceof PersonNotFoundError ||
    error instanceof PostNotFoundError ||
    error instanceof TeamNotFoundError ||
    error instanceof MentorshipNotFoundError
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (
    error instanceof SelfKudosNotAllowedError ||
    error instanceof SelfMentorshipNotAllowedError ||
    error instanceof AchievementReferenceMismatchError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (
    error instanceof TeamNameTakenError ||
    error instanceof AlreadyTeamMemberError ||
    error instanceof AlreadyHasOpenMentorshipError ||
    error instanceof MentorshipNotRequestedError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (error instanceof ExternalServiceNotConfiguredError) {
    // A missing R2 env var is an ops/config problem, not a bad request —
    // surface the exact missing-var message (this environment's documented
    // "throw a clear not-configured error" contract) rather than tRPC's
    // generic masked 500. Same precedent as `trainingRouter`'s own mapper.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  }
  throw error;
}

export const communityRouter = router({
  // --- Posts ---
  createPost: protectedProcedure
    .input(
      z.object({
        body: z.string().min(1).max(5000),
        scopeType: z.enum(["org", "chapter"]),
        scopeId: ulidSchema.nullable(),
        attachments: z
          .array(
            z.object({
              r2ObjectKey: z.string(),
              contentType: z.string(),
              sizeBytes: z.number().int().positive(),
              altText: z.string().optional(),
            }),
          )
          .max(4)
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createPost(ctx.prisma, {
          caller: callerSubject(ctx.person),
          authorChapterId: ctx.person.primaryChapterId,
          ...input,
        });
      } catch (error) {
        mapCommunityError(error);
      }
    }),

  /** See this file's header — the upload half of `createPost`'s Attachment value object (ADR-0011), not in the sketch's own TypeScript block but required for any real `r2ObjectKey` to exist. */
  initiatePostAttachmentUpload: protectedProcedure
    .input(z.object({ fileExtension: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await initiatePostAttachmentUpload({ caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapCommunityError(error);
      }
    }),

  /** Dispatches to `getChapterFeed`/`getOrgFeed` — see this file's header. */
  getFeed: protectedProcedure
    .input(
      scopePairSchema.and(
        z.object({
          cursor: ulidSchema.optional(),
          limit: z.number().int().min(1).max(50).default(30),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      if (input.scopeType === "org") {
        return getOrgFeed(ctx.prisma, { cursor: input.cursor, limit: input.limit });
      }
      // `scopePairSchema`'s own refine guarantees `scopeId` is non-null here.
      return getChapterFeed(ctx.prisma, { chapterId: input.scopeId as string, cursor: input.cursor, limit: input.limit });
    }),

  /** ADR-0017 full-text search (build item 2) — see this file's header. */
  search: protectedProcedure
    .input(
      scopePairSchema.and(
        z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      ),
    )
    .query(({ ctx, input }) =>
      searchPosts(ctx.prisma, {
        query: input.query,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        limit: input.limit,
      }),
    ),

  // --- Kudos ---
  giveKudos: protectedProcedure
    .input(
      z.object({
        toPersonId: ulidSchema,
        note: z.string().max(280).optional(),
        achievementRefType: z.string().optional(),
        achievementRefId: ulidSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await giveKudos(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapCommunityError(error);
      }
    }),

  getKudosReceived: protectedProcedure
    .input(z.object({ personId: ulidSchema, cursor: ulidSchema.optional(), limit: z.number().int().min(1).max(50).optional() }))
    .query(({ ctx, input }) => getKudosReceived(ctx.prisma, input)),

  // --- Teams ---
  createTeam: protectedProcedure
    .input(z.object({ chapterId: ulidSchema, name: z.string().min(1).max(80), description: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createTeam(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapCommunityError(error);
      }
    }),

  joinTeam: protectedProcedure
    .input(z.object({ teamId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await joinTeam(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapCommunityError(error);
      }
    }),

  // --- Mentorship ---
  requestMentorship: protectedProcedure
    .input(z.object({ mentorPersonId: ulidSchema, note: z.string().max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await requestMentorship(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapCommunityError(error);
      }
    }),

  acceptMentorship: protectedProcedure
    .input(z.object({ mentorshipId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await acceptMentorship(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapCommunityError(error);
      }
    }),
});

// Every procedure above is `protectedProcedure`, exactly matching
// docs/ddd/community-social.md's API Contract Sketch — unlike
// `training`/`volunteering`'s own catalogs, Community has no
// unauthenticated `publicProcedure` read (no course catalog/opportunity
// board equivalent), so this router imports no `publicProcedure` at all.
