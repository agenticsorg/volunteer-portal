/**
 * identity bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `identity`, per
 * ADR-0003. Procedures are thin adapters over `modules/identity/index.ts`
 * use cases (ADR-0001) — no domain logic lives here.
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
 */
import { z } from "zod";
import { isValidUlid } from "@volunteer-portal/ulid";
import {
  findPersonByAuthId,
  PersonAlreadyRegisteredError,
  registerPerson,
} from "@/modules/identity";
import { router, sessionProcedure, protectedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

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

  me: protectedProcedure.query(({ ctx }) => ctx.person),
});
