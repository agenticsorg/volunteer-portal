import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { isValidUlid, newId } from "@volunteer-portal/ulid";
import {
  AgeGateError,
  findPersonByAuthId,
  IncompleteGuardianConsentError,
  PersonAlreadyRegisteredError,
  registerPerson,
  type RegisterPersonInput,
} from "@/modules/identity";
import type { VerifiedSupabaseSession } from "@/server/auth/verified-session";

// Exercises the RegisterPerson anti-corruption translation (ADR-0006)
// against a real Postgres carrying the real `identity` schema (migrated by
// tests/integration/setup.ts) — proving the end of the chain that starts
// with a cryptographically verified Supabase JWT: given the narrow
// `{ supabaseAuthId, email }` shape `server/auth/verified-session.ts`
// produces from one, a `Person` row (plus its initial consent records and
// `PersonRegistered` domain event) lands correctly, respects the schema's
// own CHECK constraints, and is idempotent-safe against re-registration.
//
// Deliberately does not depend on the local Supabase CLI stack (that would
// break CI, which never runs `supabase start` — see .github/workflows/ci.yml).
// `registerPerson` never talks to Supabase itself; it only ever sees the
// already-verified `VerifiedSupabaseSession` shape, which this suite fakes
// directly (`scripts/verify-local-supabase-jwt.mjs` and this file's sibling
// `verifiedSession.test.ts` cover, respectively, that the real stack issues
// real verifiable JWTs, and that the verification+narrowing step itself is
// correct — together the two halves of this chain are proven, without
// requiring Docker-in-Docker in CI just to prove the join between them).
describe("registerPerson (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];

  function fakeSession(): VerifiedSupabaseSession {
    return { supabaseAuthId: newId(), email: `${newId().toLowerCase()}@example.com` };
  }

  function baseInput(overrides: Partial<RegisterPersonInput> = {}): RegisterPersonInput {
    return {
      session: fakeSession(),
      displayName: "Ada Volunteer",
      primaryChapterId: null,
      dateOfBirth: null,
      ageAttested16Plus: true,
      guardianConsent: null,
      policyVersion: "2026-01-01",
      ...overrides,
    };
  }

  afterAll(async () => {
    if (personIds.length > 0) {
      await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.identityDomainEvent.deleteMany({
        where: { aggregateType: "Person", aggregateId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
    if (chapterIds.length > 0) {
      await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    }
    await prisma.$disconnect();
  });

  it("creates a Person row keyed by the verified session's supabaseAuthId/email", async () => {
    const input = baseInput();

    const result = await registerPerson(prisma, input);
    personIds.push(result.personId);

    expect(isValidUlid(result.personId)).toBe(true);

    const row = await prisma.person.findUniqueOrThrow({ where: { id: result.personId } });
    expect(row.supabaseAuthId).toBe(input.session.supabaseAuthId);
    expect(row.email).toBe(input.session.email);
    expect(row.displayName).toBe("Ada Volunteer");
    expect(row.publicSlug).toBe(result.publicSlug);
    expect(row.status).toBe("active");
  });

  it("is findable afterward via findPersonByAuthId — the same lookup tRPC context uses", async () => {
    const input = baseInput();

    const result = await registerPerson(prisma, input);
    personIds.push(result.personId);

    const summary = await findPersonByAuthId(prisma, input.session.supabaseAuthId);
    expect(summary).toEqual({
      personId: result.personId,
      publicSlug: result.publicSlug,
      displayName: "Ada Volunteer",
      avatarUrl: null,
      status: "active",
    });
  });

  it("records a terms_of_service ConsentRecord alongside the Person", async () => {
    const input = baseInput({ policyVersion: "2099-12-31" });

    const result = await registerPerson(prisma, input);
    personIds.push(result.personId);

    const consents = await prisma.consentRecord.findMany({ where: { personId: result.personId } });
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      purpose: "terms_of_service",
      granted: true,
      policyVersion: "2099-12-31",
      source: "signup_form",
    });
  });

  it("additionally records a guardian_consent ConsentRecord when guardianConsent is supplied", async () => {
    const input = baseInput({
      ageAttested16Plus: false,
      dateOfBirth: "2015-06-01",
      guardianConsent: { guardianName: "Parent Volunteer", guardianEmail: "parent@example.com" },
    });

    const result = await registerPerson(prisma, input);
    personIds.push(result.personId);

    const consents = await prisma.consentRecord.findMany({
      where: { personId: result.personId },
      orderBy: { purpose: "asc" },
    });
    expect(consents.map((c) => c.purpose).sort()).toEqual(["guardian_consent", "terms_of_service"]);
    const guardianRecord = consents.find((c) => c.purpose === "guardian_consent");
    expect(guardianRecord).toMatchObject({
      guardianName: "Parent Volunteer",
      guardianEmail: "parent@example.com",
    });
  });

  it("emits a PersonRegistered domain event into identity.domain_events, same transaction", async () => {
    const input = baseInput();

    const result = await registerPerson(prisma, input);
    personIds.push(result.personId);

    const events = await prisma.identityDomainEvent.findMany({
      where: { aggregateType: "Person", aggregateId: result.personId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("PersonRegistered");
    expect(events[0].payload).toMatchObject({
      personId: result.personId,
      publicSlug: result.publicSlug,
    });
  });

  it("links to a real Chapter when primaryChapterId is supplied", async () => {
    const chapterId = newId();
    chapterIds.push(chapterId);
    await prisma.chapter.create({
      data: {
        id: chapterId,
        name: "Toronto Chapter",
        slug: `toronto-${chapterId.toLowerCase()}`,
        city: "Toronto",
        country: "Canada",
      },
    });

    const input = baseInput({ primaryChapterId: chapterId });
    const result = await registerPerson(prisma, input);
    personIds.push(result.personId);

    const row = await prisma.person.findUniqueOrThrow({ where: { id: result.personId } });
    expect(row.primaryChapterId).toBe(chapterId);
  });

  it("rejects registration with neither a date of birth nor a 16+ attestation (chk_persons_age_gate)", async () => {
    const input = baseInput({ ageAttested16Plus: false, dateOfBirth: null });

    await expect(registerPerson(prisma, input)).rejects.toThrow(AgeGateError);
  });

  it("rejects guardian consent missing either guardian field", async () => {
    const input = baseInput({
      guardianConsent: { guardianName: "", guardianEmail: "parent@example.com" },
    });

    await expect(registerPerson(prisma, input)).rejects.toThrow(IncompleteGuardianConsentError);
  });

  it("rejects a second registration for the same supabaseAuthId (persons.supabase_auth_id UNIQUE)", async () => {
    const session = fakeSession();
    const first = await registerPerson(prisma, baseInput({ session }));
    personIds.push(first.personId);

    await expect(registerPerson(prisma, baseInput({ session }))).rejects.toThrow(
      PersonAlreadyRegisteredError,
    );

    // No second row was created — the first registration alone stands.
    const count = await prisma.person.count({ where: { supabaseAuthId: session.supabaseAuthId } });
    expect(count).toBe(1);
  });
});
