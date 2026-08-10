import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  IncompleteGuardianConsentError,
  NoActiveConsentError,
  recordConsent,
  revokeConsent,
} from "@/modules/identity";
import { createPerson } from "./helpers/identityFixtures";

// Exercises RecordConsent/RevokeConsent (Key Use Cases 4-5): consent is
// always a new row (invariant 2), guardian_consent requires both guardian
// fields, and revocation only ever stamps revokedAt on the current row.
describe("recordConsent / revokeConsent (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  it("records a new ConsentRecord and emits ConsentRecorded", async () => {
    const person = track((await createPerson(prisma)).id);

    const { consentId } = await recordConsent(prisma, {
      personId: person,
      purpose: "newsletter",
      granted: true,
      policyVersion: "2026-01-01",
      source: "settings_page",
    });

    const row = await prisma.consentRecord.findUniqueOrThrow({ where: { id: consentId } });
    expect(row).toMatchObject({ personId: person, purpose: "newsletter", granted: true });

    const events = await prisma.identityDomainEvent.findMany({
      where: { aggregateType: "ConsentRecord", aggregateId: consentId, eventType: "ConsentRecorded" },
    });
    expect(events).toHaveLength(1);
  });

  it("a second consent decision for the same (person, purpose) is a new row, never an update", async () => {
    const person = track((await createPerson(prisma)).id);

    const first = await recordConsent(prisma, {
      personId: person,
      purpose: "analytics_cookies",
      granted: true,
      policyVersion: "v1",
      source: "settings_page",
    });
    const second = await recordConsent(prisma, {
      personId: person,
      purpose: "analytics_cookies",
      granted: false,
      policyVersion: "v1",
      source: "settings_page",
    });

    expect(second.consentId).not.toBe(first.consentId);
    const rows = await prisma.consentRecord.findMany({
      where: { personId: person, purpose: "analytics_cookies" },
    });
    expect(rows).toHaveLength(2);
  });

  it("rejects guardian_consent missing guardian fields", async () => {
    const person = track((await createPerson(prisma)).id);

    await expect(
      recordConsent(prisma, {
        personId: person,
        purpose: "guardian_consent",
        granted: true,
        policyVersion: "v1",
        source: "guardian_form",
      }),
    ).rejects.toThrow(IncompleteGuardianConsentError);
  });

  it("revokeConsent stamps revokedAt on the current active row and emits ConsentRevoked", async () => {
    const person = track((await createPerson(prisma)).id);
    const { consentId } = await recordConsent(prisma, {
      personId: person,
      purpose: "photo_publication",
      granted: true,
      policyVersion: "v1",
      source: "settings_page",
    });

    await revokeConsent(prisma, { personId: person, purpose: "photo_publication" });

    const row = await prisma.consentRecord.findUniqueOrThrow({ where: { id: consentId } });
    expect(row.revokedAt).not.toBeNull();

    const events = await prisma.identityDomainEvent.findMany({
      where: { aggregateType: "ConsentRecord", aggregateId: consentId, eventType: "ConsentRevoked" },
    });
    expect(events).toHaveLength(1);
  });

  it("revoking a purpose with no active consent throws NoActiveConsentError", async () => {
    const person = track((await createPerson(prisma)).id);

    await expect(
      revokeConsent(prisma, { personId: person, purpose: "newsletter" }),
    ).rejects.toThrow(NoActiveConsentError);
  });
});
