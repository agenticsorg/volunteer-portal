/**
 * tRPC platform setup — shared by every bounded-context sub-router.
 *
 * Per ADR-0003, tRPC is the *only* way the Next.js frontend talks to the
 * backend. This file owns the one `initTRPC` instance, the request context,
 * and the base procedure builders; bounded-context routers
 * (`./routers/*.ts`) import `router` / `publicProcedure` from here rather
 * than each creating their own tRPC instance.
 *
 * Phase 2: the context now resolves a real Supabase session
 * (ADR-0006) and the `identity.persons` row it maps to (ADR-0003's
 * Implementation Notes: "the resolved `person` ... is attached to tRPC
 * context, so every procedure has `ctx.person` available"). Verification
 * happens exactly like `proxy.ts` (`getClaims()` — real JWKS-checked
 * signature verification, not a mocked one) but this context is
 * read-only with respect to cookies: session *refresh* (writing renewed
 * cookies back to the response) is `proxy.ts`'s job, since a tRPC
 * fetch-adapter Route Handler has no response object to attach `Set-Cookie`
 * headers to mid-request the way `NextResponse` does.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { getSupabaseAuthEnv } from "../auth/env";
import { SUPABASE_COOKIE_OPTIONS } from "../auth/cookies";
import { getVerifiedSession, type VerifiedSupabaseSession } from "../auth/verified-session";
import { prisma } from "../db/prisma";
import { findPersonByAuthId, type PersonSummary } from "@/modules/identity";

/**
 * Per-request context. `supabaseSession` is the narrow, ACL'd shape from
 * `verified-session.ts` — `null` when the request has no valid session.
 * `person` is the corresponding `identity.persons` row, looked up by
 * `supabaseAuthId`; it is `null` both when unauthenticated *and* for an
 * authenticated caller who has verified with Supabase but not yet
 * completed `identity.register` (the two cases a procedure distinguishes
 * via `supabaseSession` vs. `person` being null).
 */
export async function createTRPCContext(opts: { headers: Headers }) {
  const { url, anonKey } = getSupabaseAuthEnv();
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => parseCookieHeader(opts.headers.get("cookie") ?? ""),
      // Read-only here by design — see file header. If a refresh is ever
      // attempted from within this context, @supabase/ssr logs its own
      // warning; it does not throw.
      setAll: () => {},
    },
  });

  const supabaseSession = await getVerifiedSession(supabase);
  const person = supabaseSession
    ? await findPersonByAuthId(prisma, supabaseSession.supabaseAuthId)
    : null;

  return { headers: opts.headers, prisma, supabaseSession, person };
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create();

/** Reusable building block for every bounded-context sub-router. */
export const router = t.router;

/**
 * Builds a direct (non-HTTP) caller for a router given a `Context` —
 * tRPC v11's recommended alternative to `router.createCaller`. Used by
 * integration tests to exercise real procedures (input validation, `can()`
 * checks via the use cases, error-code translation) against a real
 * database without going through an HTTP fetch adapter.
 */
export const createCallerFactory = t.createCallerFactory;

/** Base procedure with no auth requirement. */
export const publicProcedure = t.procedure;

/**
 * Requires a verified Supabase session, but not yet a registered `Person`
 * — the exact precondition `identity.register` itself needs (a caller who
 * has authenticated with Supabase but has no `Person` row yet). Narrows
 * `ctx.supabaseSession` to non-null for the resolver.
 */
export const sessionProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.supabaseSession) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "No verified Supabase session." });
  }
  return next({ ctx: { ...ctx, supabaseSession: ctx.supabaseSession as VerifiedSupabaseSession } });
});

/**
 * Requires a registered `Person` (ADR-0003's forecasted `protectedProcedure`:
 * "requiring `can(ctx.subject, ...)` ... is introduced once `identity` and
 * the `platform/policy` module exist"). The `can(subject, action, resource)`
 * policy check itself (ADR-0007) is not built in this phase — this is the
 * narrower "is anybody logged in and registered at all" guard every
 * privileged procedure will layer `can()` on top of later.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.person) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "No registered person for this session." });
  }
  return next({ ctx: { ...ctx, person: ctx.person as PersonSummary } });
});
