#!/usr/bin/env node
/**
 * Reproducible end-to-end proof that the local Supabase Auth stack issues
 * a real, asymmetrically-signed JWT, and that it verifies against the
 * stack's own real JWKS endpoint — independent of `@supabase/ssr`'s own
 * `getClaims()` implementation (which the app itself uses at runtime; see
 * apps/web/src/server/auth/verified-session.ts), using `jose` directly.
 *
 * Requires the local stack to be running: `pnpm supabase:start`.
 *
 * Usage: node scripts/verify-local-supabase-jwt.mjs
 *   (or:  pnpm verify:local-jwt)
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!ANON_KEY) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set — run this via `pnpm verify:local-jwt` " +
      "(loads .env), or export it yourself first.",
  );
  process.exit(1);
}

const testEmail = `verify-jwt-${Date.now()}@example.com`;
const testPassword = `${crypto.randomUUID()}Aa1!`;

console.log(`1. Signing up a throwaway user against the real local GoTrue (${SUPABASE_URL})...`);
const signupRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: testEmail, password: testPassword }),
});
if (!signupRes.ok) {
  console.error(`Signup failed: ${signupRes.status} ${await signupRes.text()}`);
  process.exit(1);
}
const { access_token: accessToken, user } = await signupRes.json();
console.log(`   Issued a real access_token for auth.users.id = ${user.id}`);

console.log("2. Fetching the stack's real JWKS document...");
const jwksRes = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
const jwks = await jwksRes.json();
console.log(`   ${JSON.stringify(jwks)}`);

console.log("3. Verifying the access_token's signature locally against that JWKS (via jose)...");
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
const { payload, protectedHeader } = await jwtVerify(accessToken, JWKS, {
  issuer: `${SUPABASE_URL}/auth/v1`,
  audience: "authenticated",
});
console.log(`   header:      ${JSON.stringify(protectedHeader)}`);
console.log(`   claims.sub:  ${payload.sub}`);
console.log(`   claims.email:${payload.email}`);
if (payload.sub !== user.id || payload.email !== testEmail) {
  throw new Error("Verified claims did not match the signed-up user — should be impossible.");
}
console.log("   OK — signature, issuer, audience, and expiry all verified.");

console.log("4. Negative control: a tampered signature must be rejected...");
const tampered = accessToken.slice(0, -4) + (accessToken.endsWith("AAAA") ? "BBBB" : "AAAA");
try {
  await jwtVerify(tampered, JWKS, { issuer: `${SUPABASE_URL}/auth/v1`, audience: "authenticated" });
  console.error("   FAIL: a tampered-signature token was accepted.");
  process.exit(1);
} catch (err) {
  console.log(`   OK — rejected as expected (${err.code ?? err.message}).`);
}

console.log("\nAll checks passed: the local Supabase Auth stack issues real, verifiable JWTs.");
