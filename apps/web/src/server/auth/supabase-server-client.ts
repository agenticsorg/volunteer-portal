import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { getSupabaseAuthEnv } from "./env";
import { SUPABASE_COOKIE_OPTIONS } from "./cookies";

/**
 * Builds a `@supabase/ssr` server client bound to a specific request's
 * cookie jar (ADR-0006 Implementation Notes: "Package choice: `@supabase/ssr`
 * ... Do not use the deprecated helpers package").
 *
 * Per `@supabase/ssr`'s own contract, a fresh client must be constructed
 * for every request — never cache/share one across requests — so this is a
 * factory, not a singleton. `cookies` is the caller-supplied adapter
 * (`proxy.ts` reads/writes `NextRequest`/`NextResponse` cookies directly;
 * the tRPC context and Route Handlers use `next/headers`'s `cookies()` or
 * `parseCookieHeader`), and `cookieOptions` forces every cookie this client
 * writes through `SUPABASE_COOKIE_OPTIONS` (httpOnly/secure/sameSite) —
 * callers additionally re-apply those options explicitly in their own
 * `setAll` for defense in depth, matching ADR-0006's middleware sketch.
 */
export function createSupabaseServerClient(cookies: CookieMethodsServer) {
  const { url, anonKey } = getSupabaseAuthEnv();

  return createServerClient(url, anonKey, {
    cookies,
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
  });
}
