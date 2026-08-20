import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";

// Negative test (mirrors auditLogInsertOnly.integration.test.ts's own
// standard for this repo: prove the actual DB mechanism blocks a bypass of
// the application layer, not just that the app-layer check exists).
//
// `chk_persons_age_gate` used to only check that `date_of_birth` was
// *present*, never that it actually implied 16+ — a raw INSERT (or any
// other code path that skips `registerPerson.ts`'s own real date
// arithmetic) with a fresh 8-year-old's DOB and no attestation slipped
// through. This suite inserts directly via Prisma (not through
// `registerPerson()`) specifically to prove the fix holds even when the
// application-layer check is bypassed entirely — the actual defense-in-
// depth guarantee docs/ddd/identity-access.md Person invariant 2 asks for
// ("the DB constraint is a defense-in-depth backstop").
describe("identity.persons age gate — DB-level backstop (negative test)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  function personRow(overrides: {
    id: string;
    dateOfBirth: Date | null;
    ageAttested16Plus: boolean;
  }) {
    return {
      id: overrides.id,
      publicSlug: `${overrides.id.toLowerCase()}-slug`,
      supabaseAuthId: newId(),
      email: `${overrides.id.toLowerCase()}@example.com`,
      displayName: "DB Backstop Test",
      dateOfBirth: overrides.dateOfBirth,
      ageAttested16Plus: overrides.ageAttested16Plus,
    };
  }

  it("rejects a directly-inserted row with a DOB implying under 16 and no attestation (bypassing registerPerson.ts entirely)", async () => {
    const id = track(newId());
    // An 8-year-old as of this test's run — well under 16 no matter when
    // this suite executes, and the old CHECK's only test ("IS NOT NULL")
    // would have passed this trivially.
    const eightYearsAgo = new Date();
    eightYearsAgo.setUTCFullYear(eightYearsAgo.getUTCFullYear() - 8);

    await expect(
      prisma.person.create({
        data: personRow({ id, dateOfBirth: eightYearsAgo, ageAttested16Plus: false }),
      }),
    ).rejects.toThrow(/age gate/i);

    const row = await prisma.person.findUnique({ where: { id } });
    expect(row).toBeNull();
  });

  it("rejects a DOB one day short of 16 years old, with no attestation (real date arithmetic, not year-only)", async () => {
    const id = track(newId());
    const almostSixteen = new Date();
    almostSixteen.setUTCFullYear(almostSixteen.getUTCFullYear() - 16);
    almostSixteen.setUTCDate(almostSixteen.getUTCDate() + 1); // one day short of 16

    await expect(
      prisma.person.create({
        data: personRow({ id, dateOfBirth: almostSixteen, ageAttested16Plus: false }),
      }),
    ).rejects.toThrow(/age gate/i);
  });

  it("accepts a DOB exactly implying 16+ with no attestation needed", async () => {
    const id = track(newId());
    const exactlySixteen = new Date();
    exactlySixteen.setUTCFullYear(exactlySixteen.getUTCFullYear() - 16);

    const row = await prisma.person.create({
      data: personRow({ id, dateOfBirth: exactlySixteen, ageAttested16Plus: false }),
    });
    expect(row.id).toBe(id);
  });

  it("accepts an under-16 DOB when backed by an active guardian_consent row in the same transaction (deferred constraint trigger)", async () => {
    const id = track(newId());
    const tenYearsAgo = new Date();
    tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);

    await prisma.$transaction(async (tx) => {
      await tx.person.create({
        data: personRow({ id, dateOfBirth: tenYearsAgo, ageAttested16Plus: false }),
      });
      await tx.consentRecord.create({
        data: {
          id: newId(),
          personId: id,
          purpose: "guardian_consent",
          granted: true,
          policyVersion: "2026-01-01",
          source: "guardian_form",
          guardianName: "Parent Test",
          guardianEmail: "parent@example.com",
        },
      });
    });

    const row = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(row.dateOfBirth?.toISOString().slice(0, 10)).toBe(
      tenYearsAgo.toISOString().slice(0, 10),
    );
  });

  it("still rejects an under-16 DOB when the only guardian_consent on file is revoked", async () => {
    const id = track(newId());
    const tenYearsAgo = new Date();
    tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.person.create({
          data: personRow({ id, dateOfBirth: tenYearsAgo, ageAttested16Plus: false }),
        });
        await tx.consentRecord.create({
          data: {
            id: newId(),
            personId: id,
            purpose: "guardian_consent",
            granted: true,
            policyVersion: "2026-01-01",
            source: "guardian_form",
            guardianName: "Parent Test",
            guardianEmail: "parent@example.com",
            revokedAt: new Date(),
          },
        });
      }),
    ).rejects.toThrow(/age gate/i);
  });
});
