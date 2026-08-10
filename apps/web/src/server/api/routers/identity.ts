/**
 * identity bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `identity`, per
 * ADR-0003. Procedures are thin adapters over `modules/identity/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; every `can()` check
 * (ADR-0007) happens inside the use case itself, using the caller's own
 * `identity.role_assignments` (fetched via `listActiveRoleAssignments`).
 * This file's own job is: validate input, resolve `callerId`/`requestedBy`
 * from the *verified* session (never from client input, see below), and
 * translate domain errors to `TRPCError` codes.
 *
 * `register`'s input deliberately does NOT include `supabaseAuthId` or
 * `email`, even though docs/ddd/identity-access-schema-api.md's contract
 * sketch lists them as mutation input: accepting them from the client
 * would let any caller register a `Person` under an arbitrary
 * `supabaseAuthId` they don't own, defeating the anti-corruption
 * boundary's entire point (ADR-0006). Both are instead pulled from
 * `ctx.supabaseSession`, populated only by a cryptographically verified
 * JWT (`server/api/trpc.ts`, `server/auth/verified-session.ts`) — the
 * sketch's intent ("translates a verified Supabase JWT") is honored more
 * strictly than its literal input shape.
 *
 * `dsar.requestErasure` has the same deviation for the same reason: the
 * contract sketch lists `requestedBy` as client input, but accepting it
 * as-is would let any caller pass an arbitrary `personId` as
 * `requestedBy` to impersonate an `org_admin` for the use case's own
 * `can()` check (`resource.ownerId === subject.id || isOrgAdmin(...)`
 * evaluates `subject.id` from whatever `requestedBy` the caller supplied).
 * `requestedBy` is instead always `ctx.person.personId` — the REST
 * `POST /api/v1/dsar/erasure-requests` endpoint is the one surface where
 * an explicit, separately-authenticated `requestedBy` is accepted, because
 * that endpoint has no user session to derive it from.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import { hasRoleInScope } from "@volunteer-portal/authz";
import {
  findPersonByAuthId,
  getPersonSummary,
  registerPerson,
  PersonAlreadyRegisteredError,
  listActiveRoleAssignments,
  grantRole,
  revokeRole,
  recordConsent,
  revokeConsent,
  createChapter,
  assignChapterLead,
  listChapters,
  getConsentForPerson,
  requestDataExport,
  requestErasure,
  getDsarStatus,
  ForbiddenActionError,
  RoleAssignmentNotFoundError,
  InvalidRoleScopeError,
  PersonNotFoundError,
  PersonNotActiveError,
  NoActiveConsentError,
  OpenDsarRequestExistsError,
  PersonAlreadyAnonymizedError,
  ChapterNotFoundError,
  ChapterSlugTakenError,
  NotAnActiveChapterLeadError,
  IncompleteGuardianConsentError,
  DsarRequestNotFoundError,
} from "@/modules/identity";
import { router, publicProcedure, sessionProcedure, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";
import type { RoleAssignmentRecord } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

const roleNameSchema = z.enum([
  "volunteer",
  "mentor",
  "chapter_lead",
  "content_admin",
  "org_admin",
  "moderator",
]);
const scopeTypeSchema = z.enum(["global", "chapter", "team"]);
const consentPurposeSchema = z.enum([
  "terms_of_service",
  "newsletter",
  "photo_publication",
  "leaderboard_participation",
  "analytics_cookies",
  "guardian_consent",
]);
const consentSourceSchema = z.enum([
  "signup_form",
  "settings_page",
  "guardian_form",
  "admin_override",
]);
const chapterStatusSchema = z.enum(["active", "inactive"]);

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/identity/application/`) to the appropriate `TRPCError` code.
 * Centralized here so every procedure below gets consistent HTTP-ish
 * semantics without repeating the same `if (error instanceof ...)` chain.
 */
function mapIdentityError(error: unknown): never {
  if (error instanceof ForbiddenActionError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (
    error instanceof RoleAssignmentNotFoundError ||
    error instanceof PersonNotFoundError ||
    error instanceof NoActiveConsentError ||
    error instanceof ChapterNotFoundError ||
    error instanceof DsarRequestNotFoundError
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (
    error instanceof OpenDsarRequestExistsError ||
    error instanceof PersonAlreadyAnonymizedError ||
    error instanceof ChapterSlugTakenError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (
    error instanceof InvalidRoleScopeError ||
    error instanceof IncompleteGuardianConsentError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (
    error instanceof PersonNotActiveError ||
    error instanceof NotAnActiveChapterLeadError
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  }
  throw error;
}

/** True iff `personId` holds an active, global `org_admin` role assignment. */
async function callerIsOrgAdmin(
  prisma: Parameters<typeof listActiveRoleAssignments>[0],
  personId: string,
): Promise<boolean> {
  const assignments: RoleAssignmentRecord[] = await listActiveRoleAssignments(prisma, personId);
  return hasRoleInScope(assignments, "org_admin", "global", null);
}

/**
 * Guards every read/write of another Person's identity data (role history,
 * consent state, DSAR status) that isn't already gated by a `can()` action
 * in `@volunteer-portal/authz`: the caller must either be the subject
 * themselves or hold `org_admin`. Least-privilege default for personal
 * data the contract sketch itself doesn't spell out a policy for.
 */
async function assertSelfOrOrgAdmin(
  prisma: Parameters<typeof listActiveRoleAssignments>[0],
  callerId: string,
  subjectId: string,
): Promise<void> {
  if (callerId === subjectId) return;
  if (await callerIsOrgAdmin(prisma, callerId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the person themselves or an org_admin may access this data.",
  });
}

const registerInputSchema = z.object({
  displayName: z.string().min(1).max(120),
  primaryChapterId: ulidSchema.nullable(),
  dateOfBirth: z.string().date().nullable(),
  ageAttested16Plus: z.boolean().default(false),
  guardianConsent: z
    .object({
      guardianName: z.string().min(1),
      guardianEmail: z.string().email(),
    })
    .nullable(),
  policyVersion: z.string().min(1),
});

export const identityRouter = router({
  // --- Person ---
  register: sessionProcedure.input(registerInputSchema).mutation(async ({ ctx, input }) => {
    // A Person for this session already exists — re-registration attempts
    // surface as a clear, expected CONFLICT rather than reaching the
    // use case's unique-constraint race handling.
    const existing = await findPersonByAuthId(ctx.prisma, ctx.supabaseSession.supabaseAuthId);
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "This session is already registered." });
    }

    try {
      const { personId, publicSlug } = await registerPerson(ctx.prisma, {
        session: ctx.supabaseSession,
        displayName: input.displayName,
        primaryChapterId: input.primaryChapterId,
        dateOfBirth: input.dateOfBirth,
        ageAttested16Plus: input.ageAttested16Plus,
        guardianConsent: input.guardianConsent,
        policyVersion: input.policyVersion,
      });
      return { personId, publicSlug };
    } catch (error) {
      if (error instanceof PersonAlreadyRegisteredError) {
        throw new TRPCError({ code: "CONFLICT", message: error.message });
      }
      throw error;
    }
  }),

  getPersonSummary: publicProcedure
    .input(z.object({ personId: ulidSchema }))
    .query(({ ctx, input }) => getPersonSummary(ctx.prisma, input.personId)),

  me: protectedProcedure.query(({ ctx }): PersonSummary => ctx.person),

  // --- Chapters ---
  chapters: router({
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          slug: z.string().min(1),
          city: z.string().min(1),
          region: z.string().nullable().optional(),
          country: z.string().min(1),
          foundedAt: z.string().date().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await createChapter(ctx.prisma, {
            callerId: ctx.person.personId,
            name: input.name,
            slug: input.slug,
            city: input.city,
            region: input.region ?? null,
            country: input.country,
            foundedAt: input.foundedAt ?? null,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    assignLead: protectedProcedure
      .input(z.object({ chapterId: ulidSchema, personId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          await assignChapterLead(ctx.prisma, {
            callerId: ctx.person.personId,
            chapterId: input.chapterId,
            personId: input.personId,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    list: publicProcedure
      .input(z.object({ status: chapterStatusSchema.optional() }))
      .query(({ ctx, input }) => listChapters(ctx.prisma, { status: input.status })),
  }),

  // --- Roles ---
  roles: router({
    grant: protectedProcedure
      .input(
        z.object({
          subjectId: ulidSchema,
          role: roleNameSchema,
          scopeType: scopeTypeSchema,
          scopeId: ulidSchema.nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await grantRole(ctx.prisma, {
            callerId: ctx.person.personId,
            subjectId: input.subjectId,
            role: input.role,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    revoke: protectedProcedure
      .input(z.object({ roleAssignmentId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          await revokeRole(ctx.prisma, {
            callerId: ctx.person.personId,
            roleAssignmentId: input.roleAssignmentId,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    listForSubject: protectedProcedure
      .input(z.object({ subjectId: ulidSchema }))
      .query(async ({ ctx, input }) => {
        await assertSelfOrOrgAdmin(ctx.prisma, ctx.person.personId, input.subjectId);
        return listActiveRoleAssignments(ctx.prisma, input.subjectId);
      }),
  }),

  // --- Consent ---
  consent: router({
    record: protectedProcedure
      .input(
        z.object({
          personId: ulidSchema,
          purpose: consentPurposeSchema,
          granted: z.boolean(),
          policyVersion: z.string().min(1),
          source: consentSourceSchema,
          guardianName: z.string().optional(),
          guardianEmail: z.string().email().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await assertSelfOrOrgAdmin(ctx.prisma, ctx.person.personId, input.personId);
        try {
          return await recordConsent(ctx.prisma, input);
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    revoke: protectedProcedure
      .input(z.object({ personId: ulidSchema, purpose: consentPurposeSchema }))
      .mutation(async ({ ctx, input }) => {
        await assertSelfOrOrgAdmin(ctx.prisma, ctx.person.personId, input.personId);
        try {
          await revokeConsent(ctx.prisma, {
            personId: input.personId,
            purpose: input.purpose,
            revokedBy: ctx.person.personId,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    getForPerson: protectedProcedure
      .input(z.object({ personId: ulidSchema }))
      .query(async ({ ctx, input }) => {
        await assertSelfOrOrgAdmin(ctx.prisma, ctx.person.personId, input.personId);
        return getConsentForPerson(ctx.prisma, input.personId);
      }),
  }),

  // --- DSAR ---
  dsar: router({
    requestExport: protectedProcedure
      .input(z.object({ personId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await requestDataExport(ctx.prisma, {
            personId: input.personId,
            requestedBy: ctx.person.personId,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    requestErasure: protectedProcedure
      .input(z.object({ personId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await requestErasure(ctx.prisma, {
            personId: input.personId,
            requestedBy: ctx.person.personId,
          });
        } catch (error) {
          mapIdentityError(error);
        }
      }),

    getStatus: protectedProcedure
      .input(z.object({ dsarId: ulidSchema }))
      .query(async ({ ctx, input }) => {
        try {
          const status = await getDsarStatus(ctx.prisma, input.dsarId);
          await assertSelfOrOrgAdmin(ctx.prisma, ctx.person.personId, status.personId);
          return status;
        } catch (error) {
          mapIdentityError(error);
        }
      }),
  }),
});
