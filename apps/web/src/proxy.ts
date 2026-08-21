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
 * ADR-0013 §"Correlation": "every inbound request gets a `requestId`". This
 * is the earliest point in the request lifecycle Next.js gives this app a
 * hook into (proxy.ts runs before routing), so it's the one place a
 * request-scoped id is *generated* — everything downstream (Route
 * Handlers, tRPC's `createTRPCContext`) reads it back off the
 * `x-request-id` request header this sets, rather than generating a second,
 * different id. `crypto.randomUUID()` (Web Crypto) rather than
 * `node:crypto` — proxy.ts runs on the Edge runtime, which has no Node
 * builtins.
 */
const REQUEST_ID_HEADER = "x-request-id";

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
  // Respects an id a fronting proxy/load balancer already set (real
  // production topologies commonly do this); otherwise mints a fresh one.
  // Mutating `request.headers` in place — same pattern this file already
  // uses for `request.cookies.set(...)` below — means every subsequent
  // `NextResponse.next({ request })` call in this function (including the
  // ones `setAll` below rebuilds) carries it forward to the Route
  // Handler/Server Component that ultimately serves this request.
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  request.headers.set(REQUEST_ID_HEADER, requestId);

  // Per the ADR's sketch: start with a pass-through response, then let the
  // Supabase client's `setAll` rebuild it with the request's refreshed
  // cookies attached, so downstream Server Components/Route Handlers in
  // *this* request see the up-to-date session too, not just the client's
  // eventual response.
  let response = NextResponse.next({ request });
  response.headers.set(REQUEST_ID_HEADER, requestId);

  const { url, anonKey } = getSupabaseAuthEnv();
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        response.headers.set(REQUEST_ID_HEADER, requestId);
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
    const redirectResponse = NextResponse.redirect(loginUrl);
    redirectResponse.headers.set(REQUEST_ID_HEADER, requestId);
    return redirectResponse;
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
