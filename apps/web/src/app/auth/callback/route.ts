/**
 * Supabase OAuth / magic-link callback (the canonical `@supabase/ssr` +
 * Next.js App Router pattern for the PKCE flow `createServerClient`
 * defaults to — see `SupabaseAuthEnv`/`createSupabaseServerClient`).
 *
 * After `signInWithOAuth()` or a magic-link email, Supabase redirects the
 * browser here with a one-time `?code=`. This route exchanges it for a
 * real session server-side and writes the httpOnly session cookie
 * (ADR-0006's Decision: "the Supabase JWT ... is exchanged server-side for
 * a session cookie"), then redirects into the app. It does not create a
 * `Person` row — `identity.register` (a separate, explicit step once a
 * signup form has collected the fields `RegisterPerson` requires: display
 * name, age gate, policy version, ...) owns that, per the ACL boundary.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/server/auth/supabase-server-client";
import { SUPABASE_COOKIE_OPTIONS } from "@/server/auth/cookies";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", request.url));
  }

  const response = NextResponse.redirect(new URL(next, request.url));

  const supabase = createSupabaseServerClient({
    getAll: () => request.cookies.getAll(),
    setAll: (cookiesToSet) =>
      cookiesToSet.forEach(({ name, value, options }) =>
        response.cookies.set(name, value, { ...options, ...SUPABASE_COOKIE_OPTIONS }),
      ),
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/login?error=exchange_failed", request.url));
  }

  return response;
}
