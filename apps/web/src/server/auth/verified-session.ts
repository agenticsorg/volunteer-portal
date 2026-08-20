import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The Supabase Auth ↔ domain-model anti-corruption boundary
 * (ADR-0006 "Integration & Anti-Corruption Notes" in
 * docs/ddd/identity-access-schema-api.md: "Supabase Auth is behind an
 * anti-corruption layer... If the auth provider is ever swapped, only this
 * translation boundary changes").
 *
 * This file is the ONLY place in the app allowed to know what a Supabase
 * JWT's claims look like (`sub`, `email`, `aud`, `role`, `app_metadata`,
 * `@supabase/supabase-js`'s `Session`/`User` types, ...). Every caller —
 * `proxy.ts`, the tRPC context, and `modules/identity`'s `registerPerson`
 * use case — sees only `VerifiedSupabaseSession`, two plain strings with no
 * Supabase-specific shape at all.
 */

/**
 * The only representation of "who is this, per a cryptographically
 * verified Supabase session" permitted to exist anywhere outside this
 * file. Deliberately not `import("@supabase/supabase-js").User` — that
 * type carries dozens of Supabase-specific fields (`app_metadata`,
 * `identities`, `factors`, `is_anonymous`, ...) this app has no business
 * modeling itself around, and coupling to it would mean a future
 * auth-provider swap (ADR-0006's documented migration path) touches every
 * call site instead of just this one.
 */
export interface VerifiedSupabaseSession {
  /**
   * Supabase `auth.users.id` (a UUID). Stored verbatim as
   * `identity.persons.supabase_auth_id` — never reused as `persons.id`
   * itself, which stays a ULID per ADR-0005 (see ADR-0006's Decision).
   */
  supabaseAuthId: string;
  email: string;
}

/**
 * Resolves the verified caller behind `supabase`'s bound request/cookies,
 * or `null` if there is no session or it fails verification.
 *
 * Delegates the actual cryptography to `supabase.auth.getClaims()`
 * (`@supabase/auth-js`'s `GoTrueClient.getClaims`), which for this app's
 * Supabase stack (local CLI stack now, a hosted project later — both issue
 * asymmetric ES256-signed access tokens by default) fetches the project's
 * real JWKS document (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
 * caches it, and verifies the JWT's signature locally via the WebCrypto
 * API — it is not a mocked or hand-rolled verifier, and not merely a
 * client-side `atob()` decode. It also transparently refreshes an
 * about-to-expire access token (using the refresh token already in the
 * cookie jar) before validating, which is what makes a single call here
 * sufficient for both "is this session valid" and "keep it alive."
 * (Verified against this repo's own local stack — see the README's "Local
 * Supabase Auth stack" section for the reproducible proof: a real
 * ES256-signed token, independently re-verified against the same JWKS
 * endpoint via `jose`, with a tampered-signature negative control.)
 *
 * Falls back to a live `getUser()` call (a network round-trip to the Auth
 * server, still real, never mocked) only in the legacy case of a
 * symmetric (HS256) shared-secret signing key, where local verification
 * isn't possible without the secret itself.
 */
export async function getVerifiedSession(
  supabase: SupabaseClient,
): Promise<VerifiedSupabaseSession | null> {
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data) {
    return null;
  }

  const { claims } = data;
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    return null;
  }

  return { supabaseAuthId: claims.sub, email: claims.email };
}
