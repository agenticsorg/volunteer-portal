/**
 * gamification bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `gamification`, per
 * ADR-0003. Procedures are thin adapters over `modules/gamification/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; every `can()` check
 * (ADR-0007) happens inside the use case itself (via
 * `assertGamificationAuthority`), using the caller's own
 * `identity.role_assignments`. This file's own job is: validate input,
 * resolve the caller's `PolicySubject`/`personId` from the *verified*
 * session (never from client input — same anti-corruption discipline as
 * `identityRouter`/`volunteeringRouter`/`trainingRouter`), and translate
 * domain errors to `TRPCError` codes.
 *
 * There is no `adminProcedure` builder in this codebase (see `../trpc.ts`)
 * — staff-only mutations (`adminAdjustPoints`, `adminAwardBadge`) are
 * `protectedProcedure` here too, exactly like `trainingRouter.createCourse`
 * et al.; the actual staff-only gate is `assertGamificationAuthority`'s
 * `can()` check inside the use case, not the procedure builder.
 *
 * Shaped per the API Contract Sketch in docs/ddd/gamification.md.
 *
 * Leaderboard scope (build item 2 of this phase): `getLeaderboard`'s input
 * schema only admits `scopeType: 'team' | 'challenge'` — there is no
 * `'global'` member for a malformed request to select, so an unscoped
 * request is rejected by zod before it ever reaches the use case. The use
 * case's own `assertScopedLeaderboard` (docs/ddd/gamification.md's runtime
 * backstop) is the second, independent layer behind that — see this
 * router's own `getLeaderboard` doc comment.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  getPointsBalance,
  getPersonGamificationProfile,
  listBadges,
  getLeaderboard,
  getMyStreak,
  adminAdjustPoints,
  adminAwardBadge,
  ForbiddenActionError,
  UnscopedLeaderboardError,
  ManualAdjustmentReasonRequiredError,
  BadgeNotFoundError,
  PersonNotFoundError,
} from "@/modules/gamification";
import { router, publicProcedure, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

/** Builds the `PolicySubject` every privileged use case's `caller` argument needs, from the already-resolved session `Person` — same helper as `trainingRouter`/`volunteeringRouter`'s own `callerSubject`. */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/gamification/application/`) to the appropriate `TRPCError` code.
 * Centralized here, same shape as `trainingRouter`'s `mapTrainingError` and
 * `volunteeringRouter`'s `mapVolunteeringError`.
 */
function mapGamificationError(error: unknown): never {
  if (error instanceof ForbiddenActionError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (error instanceof BadgeNotFoundError || error instanceof PersonNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof UnscopedLeaderboardError || error instanceof ManualAdjustmentReasonRequiredError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

export const gamificationRouter = router({
  getMyPointsBalance: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await getPointsBalance(ctx.prisma, ctx.person.personId);
    } catch (error) {
      mapGamificationError(error);
    }
  }),

  getPersonGamificationProfile: publicProcedure
    .input(z.object({ personId: ulidSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getPersonGamificationProfile(ctx.prisma, input.personId);
      } catch (error) {
        mapGamificationError(error);
      }
    }),

  listBadges: publicProcedure
    .input(z.object({ activeOnly: z.boolean().default(true) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listBadges(ctx.prisma, input);
      } catch (error) {
        mapGamificationError(error);
      }
    }),

  /**
   * `scopeType` only admits `'team' | 'challenge'` (docs/ddd/gamification.md's
   * API Contract Sketch: "'global' is not a representable value") — this is
   * the Phase 5 completion bar's "no leaderboard API path can return an
   * unscoped, platform-wide ranking — assert this at the API layer itself"
   * requirement, enforced twice over: zod rejects any other `scopeType`
   * before this resolver ever runs, and `getLeaderboard` itself re-asserts
   * via `assertScopedLeaderboard` as a second, independent backstop.
   */
  getLeaderboard: protectedProcedure
    .input(
      z.object({
        scopeType: z.enum(["team", "challenge"]),
        scopeId: ulidSchema,
        periodStart: z.string().datetime().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await getLeaderboard(ctx.prisma, {
          scope: { scopeType: input.scopeType, scopeId: input.scopeId },
          periodStart: input.periodStart ? new Date(input.periodStart) : undefined,
        });
      } catch (error) {
        mapGamificationError(error);
      }
    }),

  getMyStreak: protectedProcedure
    .input(z.object({ activityType: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await getMyStreak(ctx.prisma, ctx.person.personId, input.activityType);
      } catch (error) {
        mapGamificationError(error);
      }
    }),

  // --- Staff-only (gated inside the use case via assertGamificationAuthority) ---
  adminAdjustPoints: protectedProcedure
    .input(z.object({ personId: ulidSchema, points: z.number().int(), reason: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await adminAdjustPoints(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapGamificationError(error);
      }
    }),

  adminAwardBadge: protectedProcedure
    .input(z.object({ personId: ulidSchema, badgeId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await adminAwardBadge(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapGamificationError(error);
      }
    }),
});
