import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVerifiedSession } from "@/server/auth/verified-session";

// Fakes the one method `getVerifiedSession` calls
// (`supabase.auth.getClaims()`) — the real cryptographic verification
// against a live JWKS endpoint is exercised end-to-end by
// `scripts/verify-local-supabase-jwt.mjs` against the actual local
// Supabase stack (see the README); this suite only needs to prove the
// narrowing/mapping logic on top of whatever `getClaims()` returns,
// without depending on Docker or the network in CI.
function fakeSupabaseClient(getClaims: () => ReturnType<SupabaseClient["auth"]["getClaims"]>) {
  return { auth: { getClaims } } as unknown as SupabaseClient;
}

describe("getVerifiedSession", () => {
  it("maps a verified session's claims to { supabaseAuthId, email } only", async () => {
    const supabase = fakeSupabaseClient(() =>
      Promise.resolve({
        data: {
          claims: {
            sub: "11111111-1111-1111-1111-111111111111",
            email: "volunteer@example.com",
            aud: "authenticated",
            role: "authenticated",
            app_metadata: { provider: "email" },
          },
          header: { alg: "ES256", kid: "k1", typ: "JWT" },
          signature: new Uint8Array(),
        },
        error: null,
      }) as never,
    );

    const session = await getVerifiedSession(supabase);

    expect(session).toEqual({
      supabaseAuthId: "11111111-1111-1111-1111-111111111111",
      email: "volunteer@example.com",
    });
    // Nothing beyond the two ACL'd fields survives the translation.
    expect(Object.keys(session ?? {}).sort()).toEqual(["email", "supabaseAuthId"]);
  });

  it("returns null when getClaims() reports an error (invalid/expired/missing token)", async () => {
    const supabase = fakeSupabaseClient(() =>
      Promise.resolve({ data: null, error: { message: "invalid JWT" } }) as never,
    );

    await expect(getVerifiedSession(supabase)).resolves.toBeNull();
  });

  it("returns null when there is no session at all (no error, no data)", async () => {
    const supabase = fakeSupabaseClient(() => Promise.resolve({ data: null, error: null }) as never);

    await expect(getVerifiedSession(supabase)).resolves.toBeNull();
  });

  it("returns null if claims are missing sub or email (malformed/unexpected claim shape)", async () => {
    const supabase = fakeSupabaseClient(() =>
      Promise.resolve({
        data: {
          claims: { sub: "11111111-1111-1111-1111-111111111111" },
          header: { alg: "ES256", kid: "k1", typ: "JWT" },
          signature: new Uint8Array(),
        },
        error: null,
      }) as never,
    );

    await expect(getVerifiedSession(supabase)).resolves.toBeNull();
  });
});
