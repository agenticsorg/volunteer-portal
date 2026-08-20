import { createClient } from "@supabase/supabase-js";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { registerPerson } from "@/modules/identity";
import { getVerifiedSession } from "@/server/auth/verified-session";

/**
 * Proves the one link the rest of the identity integration suite
 * deliberately fakes (see registerPerson.integration.test.ts's own header
 * comment: "Deliberately does not depend on the local Supabase CLI stack —
 * that would break CI, which never runs `supabase start`"): that a real
 * signup against the real local Supabase Auth stack (GoTrue), verified
 * through the app's own production verification code path
 * (`server/auth/verified-session.ts`'s `getVerifiedSession()` — real JWKS
 * fetch, real ES256 signature check, no mocking), produces a
 * `VerifiedSupabaseSession` that `registerPerson` turns into a real
 * `Person` row plus its `terms_of_service` `ConsentRecord`, in the same
 * testcontainers Postgres every other file in this directory uses (no
 * second harness).
 *
 * Still uses tests/integration/setup.ts's testcontainers Postgres for the
 * `identity` schema — only the *auth* half comes from the separate,
 * already-running local Supabase CLI stack (`pnpm supabase:start`; see
 * README's "Local Supabase Auth stack" section). Since CI never starts
 * that stack, this suite skips itself (not fails) when
 * `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` aren't set or
 * the stack isn't reachable — run it locally via:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=$(supabase status -o json | jq -r .API_URL) \
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=$(supabase status -o json | jq -r .ANON_KEY) \
 *   pnpm --filter web exec vitest run --project integration supabaseSignup
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function isLocalSupabaseReachable(): Promise<boolean> {
  if (!ANON_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const supabaseAvailable = await isLocalSupabaseReachable();

describe.skipIf(!supabaseAvailable)(
  "real Supabase Auth signup -> RegisterPerson (integration, requires `pnpm supabase:start`)",
  () => {
    const prisma = new PrismaClient();
    const personIds: string[] = [];

    afterAll(async () => {
      if (personIds.length > 0) {
        await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.identityDomainEvent.deleteMany({
          where: { aggregateType: "Person", aggregateId: { in: personIds } },
        });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      }
      await prisma.$disconnect();
    });

    it(
      "a real GoTrue signup, verified via the app's own getVerifiedSession(), " +
        "creates a Person row and a terms_of_service ConsentRecord",
      async () => {
        const email = `phase2-verify-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
        const password = `${crypto.randomUUID()}Aa1!`;

        const supabase = createClient(SUPABASE_URL, ANON_KEY!);
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });
        expect(signUpError).toBeNull();
        expect(signUpData.user).not.toBeNull();
        // Local stack has email confirmation disabled (supabase/config.toml
        // `auth.email.enable_confirmations = false`) so signUp returns a
        // usable session immediately, same as verify-local-supabase-jwt.mjs.
        expect(signUpData.session).not.toBeNull();

        // The exact production verification path: real JWKS fetch, real
        // ES256 signature check via WebCrypto — not mocked.
        const verified = await getVerifiedSession(supabase);
        expect(verified).not.toBeNull();
        expect(verified!.supabaseAuthId).toBe(signUpData.user!.id);
        expect(verified!.email).toBe(email);

        const result = await registerPerson(prisma, {
          session: verified!,
          displayName: "Real Supabase Signup",
          primaryChapterId: null,
          dateOfBirth: null,
          ageAttested16Plus: true,
          guardianConsent: null,
          policyVersion: "2026-01-01",
        });
        personIds.push(result.personId);

        const person = await prisma.person.findUniqueOrThrow({ where: { id: result.personId } });
        expect(person.supabaseAuthId).toBe(signUpData.user!.id);
        expect(person.email).toBe(email);
        expect(person.status).toBe("active");

        const consents = await prisma.consentRecord.findMany({
          where: { personId: result.personId },
        });
        expect(consents).toHaveLength(1);
        expect(consents[0]).toMatchObject({ purpose: "terms_of_service", granted: true });
      },
    );
  },
);
