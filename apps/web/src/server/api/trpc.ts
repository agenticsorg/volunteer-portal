/**
 * tRPC platform setup — shared by every bounded-context sub-router.
 *
 * Per ADR-0003, tRPC is the *only* way the Next.js frontend talks to the
 * backend. This file owns the one `initTRPC` instance, the request context,
 * and the base procedure builders; bounded-context routers
 * (`./routers/*.ts`) import `router` / `publicProcedure` from here rather
 * than each creating their own tRPC instance.
 *
 * Phase 0 scope: no domain logic exists yet (no Person, no auth session),
 * so the context is intentionally empty. ADR-0003's Implementation Notes
 * describe a Supabase-session-derived `subject` on `ctx` and a
 * `protectedProcedure` that requires it — that lands once the `identity`
 * module has something to authenticate against.
 */
import { initTRPC } from "@trpc/server";

/**
 * Per-request context. Carries the raw request headers so a future
 * `identity`-backed context builder can resolve the Supabase session
 * cookie from them; nothing reads `headers` yet (no auth in Phase 0).
 */
export function createTRPCContext(opts: { headers: Headers }) {
  return { headers: opts.headers };
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create();

/** Reusable building block for every bounded-context sub-router. */
export const router = t.router;

/**
 * Base procedure with no auth requirement. Every procedure in Phase 0 is
 * built from this — `protectedProcedure` (requiring `can(ctx.subject, ...)`
 * per ADR-0003) is introduced once `identity` and the `platform/policy`
 * module exist.
 */
export const publicProcedure = t.procedure;
