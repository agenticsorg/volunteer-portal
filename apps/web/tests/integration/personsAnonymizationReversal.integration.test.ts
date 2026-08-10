import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { requestErasure } from "@/modules/identity";
import { createPerson } from "./helpers/identityFixtures";

// Negative test, same structure as auditLogInsertOnly.integration.test.ts
// (Phase 1's own template for "prove a trigger actually blocks a
// mutation, not just that the app-layer says not to"): Person invariant 3
// ("* -> anonymized is terminal — no code path may set status away from
// anonymized") previously had no DB-level backstop at all —
// `chk_persons_anonymized_at` only checks a row's CURRENT state
// (`anonymized_at IS NOT NULL` iff `status = 'anonymized'`), which a
// simultaneous `status = 'active', anonymized_at = NULL` UPDATE satisfies
// exactly as well as any other valid row. This suite issues that exact
// UPDATE directly via Prisma (bypassing every application-layer code path
// entirely, including `requestErasure`) and asserts it is rejected, then
// re-reads the row to confirm it is byte-for-byte unchanged.
describe("identity.persons anonymization is terminal — DB-level backstop (negative test)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.dSARRequest.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function anonymizedPerson() {
    const person = track((await createPerson(prisma, { displayName: "Reversal Test" })).id);
    await requestErasure(prisma, { personId: person, requestedBy: person });
    return person;
  }

  it("rejects an UPDATE that simultaneously flips status back to active and clears anonymized_at", async () => {
    const person = await anonymizedPerson();
    const before = await prisma.person.findUniqueOrThrow({ where: { id: person } });
    expect(before.status).toBe("anonymized");
    expect(before.anonymizedAt).not.toBeNull();

    await expect(
      prisma.person.update({
        where: { id: person },
        data: { status: "active", anonymizedAt: null },
      }),
    ).rejects.toThrow(/anonymization is terminal/i);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person } });
    expect(after).toEqual(before);
  });

  it("rejects status alone moving away from anonymized, even if anonymized_at is left untouched", async () => {
    const person = await anonymizedPerson();

    // status='deactivated' with anonymized_at still set would itself also
    // violate chk_persons_anonymized_at (a different, pre-existing CHECK),
    // but the assertion here is specifically that THIS trigger is the one
    // that fires — Postgres runs BEFORE ROW triggers before CHECK
    // constraints are (re-)evaluated for the row, so the trigger's own
    // RAISE EXCEPTION message is what surfaces.
    await expect(
      prisma.$executeRaw`UPDATE identity.persons SET status = 'deactivated' WHERE id = ${person}`,
    ).rejects.toThrow(/anonymization is terminal/i);
  });

  it("rejects anonymized_at being cleared alone, even if status is left as anonymized", async () => {
    const person = await anonymizedPerson();

    await expect(
      prisma.$executeRaw`UPDATE identity.persons SET anonymized_at = NULL WHERE id = ${person}`,
    ).rejects.toThrow(/anonymization is terminal/i);

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person } });
    expect(after.anonymizedAt).not.toBeNull();
  });

  it("still allows an ordinary UPDATE into 'anonymized' for the first time (the trigger only blocks reversal, not the transition itself)", async () => {
    const person = track((await createPerson(prisma, { displayName: "First Anonymization" })).id);

    const anonymizedAt = new Date();
    await prisma.person.update({
      where: { id: person },
      data: {
        status: "anonymized",
        anonymizedAt,
        email: `anonymized+${person.toLowerCase()}@volunteer-portal.invalid`,
        displayName: "Deleted User",
      },
    });

    const row = await prisma.person.findUniqueOrThrow({ where: { id: person } });
    expect(row.status).toBe("anonymized");
    expect(row.anonymizedAt).not.toBeNull();
  });

  it("still allows unrelated field updates (avatarUrl) on an anonymized row that don't touch status/anonymized_at", async () => {
    const person = await anonymizedPerson();

    // avatarUrl was already nulled by requestErasure; updating it again
    // (still null) exercises an UPDATE statement on the row without
    // touching status/anonymized_at at all.
    await expect(
      prisma.person.update({ where: { id: person }, data: { bio: null } }),
    ).resolves.toBeDefined();
  });

  it("(sanity) requestErasure itself cannot be used to reverse an existing anonymization", async () => {
    const person = await anonymizedPerson();
    // requestErasure's own PersonAlreadyAnonymizedError guard fires first
    // — this just documents that there is no code path, including the use
    // case that performs anonymization in the first place, that reverses
    // it.
    await expect(requestErasure(prisma, { personId: person, requestedBy: person })).rejects.toThrow();

    const row = await prisma.person.findUniqueOrThrow({ where: { id: person } });
    expect(row.status).toBe("anonymized");
  });
});
