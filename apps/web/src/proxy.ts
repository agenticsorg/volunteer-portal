/**
 * Next.js Proxy — verifies and refreshes the Supabase Auth session cookie
 * on every request (ADR-0006's Decision: "Next.js middleware ... runs on
 * every request to protected routes, validates/refreshes the session").
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 deprecated and renamed
 * the `middleware.ts` file convention to `proxy.ts` (functionality
 * unchanged, export renamed `middleware` → `proxy`) — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
 * ("The `middleware.js` file convention has been deprecated ... and
 * renamed to `proxy.js`"). `apps/web/AGENTS.md` warns this Next version
 * has breaking changes from training-data expectations; this is one of
 * them.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAuthEnv } from "@/server/auth/env";
import { SUPABASE_COOKIE_OPTIONS } from "@/server/auth/cookies";
import { getVerifiedSession } from "@/server/auth/verified-session";

/**
 * Path prefixes that require a verified session. Empty in this phase —
 * Phase 2 ships the auth *infrastructure* (this file, session cookies, the
 * RegisterPerson translation) but no authenticated-only pages yet; no UI
 * has been built for any bounded context. Add prefixes here as protected
 * pages land (e.g. `/account`, `/admin`).
 */
const PROTECTED_PATH_PREFIXES: readonly string[] = [];

function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function proxy(request: NextRequest) {
  // Per the ADR's sketch: start with a pass-through response, then let the
  // Supabase client's `setAll` rebuild it with the request's refreshed
  // cookies attached, so downstream Server Components/Route Handlers in
  // *this* request see the up-to-date session too, not just the client's
  // eventual response.
  let response = NextResponse.next({ request });

  const { url, anonKey } = getSupabaseAuthEnv();
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, { ...options, ...SUPABASE_COOKIE_OPTIONS }),
        );
      },
    },
  });

  // Cryptographically verifies the access token (real JWKS signature
  // check — see verified-session.ts) and transparently refreshes it first
  // if it's about to expire, in which case `setAll` above persists the
  // renewed cookie onto `response`.
  const session = await getVerifiedSession(supabase);

  if (!session && isProtectedRoute(request.nextUrl.pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Every route except static assets and the favicon — deliberately
    // still includes /api/trpc/* so API calls also get their session
    // cookie refreshed, not just page navigations (see proxy.md's
    // "Negative matching" guidance).
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
