import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import {
  ForbiddenActionError,
  OpenDsarRequestExistsError,
  PersonAlreadyAnonymizedError,
  grantRole,
  requestDataExport,
  requestErasure,
} from "@/modules/identity";
import { GET as dsarExportRoute } from "@/app/api/v1/persons/[personId]/dsar-export/route";
import { POST as erasureRequestsRoute } from "@/app/api/v1/dsar/erasure-requests/route";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";

const TEST_ADMIN_API_KEY = "test-admin-api-key-for-integration-suite";

function postErasureRequest(body: unknown, apiKey: string | null = TEST_ADMIN_API_KEY) {
  return erasureRequestsRoute(
    new NextRequest(new URL("http://localhost/api/v1/dsar/erasure-requests"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

// Exercises RequestDataExport / RequestErasure-AnonymizePerson (Key Use
// Cases 6-7) end to end: a real DSARRequest state machine, a real file
// written to local export storage, a real signed & expiring download URL,
// and — for erasure — real, irreversible anonymization of identifying
// Person fields with aggregate rows (RoleAssignment, ConsentRecord)
// preserved (never a cascade delete).
describe("requestDataExport / requestErasure (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.dSARRequest.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  describe("requestDataExport", () => {
    it("completes synchronously with a real, downloadable, signed export artifact", async () => {
      const person = track((await createPerson(prisma, { displayName: "Export Me" })).id);

      const { dsarId } = await requestDataExport(prisma, { personId: person, requestedBy: person });

      const row = await prisma.dSARRequest.findUniqueOrThrow({ where: { id: dsarId } });
      expect(row.status).toBe("completed");
      expect(row.completedAt).not.toBeNull();
      expect(row.exportFileUrl).toMatch(new RegExp(`^/api/v1/persons/${person}/dsar-export\\?token=`));

      const events = await prisma.identityDomainEvent.findMany({
        where: { aggregateType: "DSARRequest", aggregateId: dsarId, eventType: "DSARRequested" },
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ dsarId, personId: person, type: "export" });

      // The signed URL is real and independently verifiable through the
      // actual Route Handler — not just a DB field.
      const request = new NextRequest(new URL(`http://localhost${row.exportFileUrl}`));
      const response = await dsarExportRoute(request, { params: Promise.resolve({ personId: person }) });
      expect(response.status).toBe(200);
      const bundle = await response.json();
      expect(bundle.person).toMatchObject({ id: person, displayName: "Export Me" });
    });

    it("masks dateOfBirth to year-only when an org_admin exports on another person's behalf", async () => {
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const subject = track(
        (await createPerson(prisma, { dateOfBirth: new Date("2001-03-14") })).id,
      );

      const { dsarId } = await requestDataExport(prisma, { personId: subject, requestedBy: admin });
      const row = await prisma.dSARRequest.findUniqueOrThrow({ where: { id: dsarId } });
      const request = new NextRequest(new URL(`http://localhost${row.exportFileUrl}`));
      const response = await dsarExportRoute(request, { params: Promise.resolve({ personId: subject }) });
      const bundle = await response.json();

      expect(bundle.person.dateOfBirth).toBe("2001");
    });

    it("rejects a request for another person's data without org_admin", async () => {
      const requester = track((await createPerson(prisma)).id);
      const subject = track((await createPerson(prisma)).id);

      await expect(
        requestDataExport(prisma, { personId: subject, requestedBy: requester }),
      ).rejects.toThrow(ForbiddenActionError);
    });

    it("rejects a request when an export is already open for this person", async () => {
      const person = track((await createPerson(prisma)).id);
      await prisma.dSARRequest.create({
        data: { id: newId(), personId: person, type: "export", status: "processing", requestedBy: person },
      });

      await expect(
        requestDataExport(prisma, { personId: person, requestedBy: person }),
      ).rejects.toThrow(OpenDsarRequestExistsError);
    });

    it("the download route rejects a tampered token", async () => {
      const person = track((await createPerson(prisma)).id);
      const { dsarId } = await requestDataExport(prisma, { personId: person, requestedBy: person });
      const row = await prisma.dSARRequest.findUniqueOrThrow({ where: { id: dsarId } });

      const tampered = row.exportFileUrl!.replace(/token=.+$/, "token=forged.forged");
      const request = new NextRequest(new URL(`http://localhost${tampered}`));
      const response = await dsarExportRoute(request, { params: Promise.resolve({ personId: person }) });
      expect(response.status).toBe(403);
    });
  });

  describe("requestErasure", () => {
    it("anonymizes identifying fields, preserves aggregate rows, and emits PersonAnonymized", async () => {
      const person = track(
        (await createPerson(prisma, { displayName: "Erase Me", dateOfBirth: new Date("1999-05-01") })).id,
      );
      await prisma.person.update({ where: { id: person }, data: { avatarUrl: "https://example.com/a.png" } });
      await grantRoleDirect(prisma, { subjectId: person, role: "volunteer", grantedBy: person });

      const { dsarId, anonymizedAt } = await requestErasure(prisma, {
        personId: person,
        requestedBy: person,
      });

      const row = await prisma.person.findUniqueOrThrow({ where: { id: person } });
      expect(row.status).toBe("anonymized");
      expect(row.anonymizedAt?.toISOString()).toBe(anonymizedAt);
      expect(row.displayName).toBe("Deleted User");
      expect(row.email).toBe(`anonymized+${person.toLowerCase()}@volunteer-portal.invalid`);
      expect(row.bio).toBeNull();
      expect(row.avatarUrl).toBeNull();
      expect(row.dateOfBirth).toBeNull();

      const dsarRow = await prisma.dSARRequest.findUniqueOrThrow({ where: { id: dsarId } });
      expect(dsarRow.status).toBe("completed");

      // Aggregate data other contexts might reference is preserved —
      // never a cascade delete. It IS revoked, though (not left silently
      // active): the row still exists (RoleAssignment invariant 3's
      // never-delete rule), but revokedBy/revokedAt are now set, same
      // shape revokeRole.ts itself produces.
      const roles = await prisma.roleAssignment.findMany({ where: { subjectId: person } });
      expect(roles).toHaveLength(1);
      expect(roles[0].revokedAt).not.toBeNull();
      expect(roles[0].revokedBy).toBe(person);
      expect(roles[0].revokedAt?.toISOString()).toBe(anonymizedAt);

      const events = await prisma.identityDomainEvent.findMany({
        where: { aggregateType: "Person", aggregateId: person, eventType: "PersonAnonymized" },
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ personId: person, anonymizedAt });

      // recordAuditEvent() tagged this privileged action audit: true.
      const auditEvents = await prisma.identityDomainEvent.findMany({
        where: { aggregateType: "person", aggregateId: person, eventType: "audit.recorded" },
      });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].payload).toMatchObject({ audit: true, action: "person.anonymize" });
    });

    it("cannot be requested a second time once already anonymized", async () => {
      // Requested by a separate, still-active org_admin rather than the
      // subject themselves: a *self*-requested second erasure is now
      // caught earlier, by can()'s own caller-status check (the subject's
      // own session is no longer "active" after the first call succeeds —
      // see the dedicated caller-status test below) — this test isolates
      // the DSARRequest/PersonAlreadyAnonymizedError business rule this
      // use case's Pre-condition actually names, independent of that.
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const person = track((await createPerson(prisma)).id);
      await requestErasure(prisma, { personId: person, requestedBy: admin });

      await expect(
        requestErasure(prisma, { personId: person, requestedBy: admin }),
      ).rejects.toThrow(PersonAlreadyAnonymizedError);
    });

    it("a self-requested second erasure attempt is denied by can()'s caller-status check before it ever reaches the already-anonymized business rule", async () => {
      const person = track((await createPerson(prisma)).id);
      await requestErasure(prisma, { personId: person, requestedBy: person });

      // The subject's own session is technically still "valid" (same
      // callerId), but their Person.status is now anonymized — can()
      // fails closed on that before any target-status business rule is
      // even reached.
      await expect(
        requestErasure(prisma, { personId: person, requestedBy: person }),
      ).rejects.toThrow(ForbiddenActionError);
    });

    it("rejects an erasure request for another person without org_admin", async () => {
      const requester = track((await createPerson(prisma)).id);
      const subject = track((await createPerson(prisma)).id);

      await expect(
        requestErasure(prisma, { personId: subject, requestedBy: requester }),
      ).rejects.toThrow(ForbiddenActionError);
    });

    it("an org_admin can request erasure on another person's behalf", async () => {
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const subject = track((await createPerson(prisma)).id);

      const { dsarId } = await requestErasure(prisma, { personId: subject, requestedBy: admin });
      const dsarRow = await prisma.dSARRequest.findUniqueOrThrow({ where: { id: dsarId } });
      expect(dsarRow.requestedBy).toBe(admin);
      expect(dsarRow.status).toBe("completed");
    });

    // Reviewer-verified gap, closed two ways at once, proven together
    // here: (1) can()'s new caller-status check denies a still-registered,
    // still-session-valid but anonymized caller outright; (2) requestErasure
    // itself now revokes the erased person's own role_assignments in the
    // same transaction as the anonymization, so the stale grant doesn't
    // linger even as inert data.
    it("an anonymized former org_admin can no longer grant roles even with a still-valid session, and their role_assignments are revoked immediately after erasure", async () => {
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const subject = track((await createPerson(prisma)).id);

      const { anonymizedAt } = await requestErasure(prisma, { personId: admin, requestedBy: admin });

      // Revoked, not deleted, in the same transaction as the
      // anonymization (RoleAssignment invariant 3).
      const roleRow = await prisma.roleAssignment.findFirstOrThrow({
        where: { subjectId: admin, role: "org_admin" },
      });
      expect(roleRow.revokedAt).not.toBeNull();
      expect(roleRow.revokedBy).toBe(admin);
      expect(roleRow.revokedAt?.toISOString()).toBe(anonymizedAt);

      // Same callerId — simulating the "still cryptographically valid
      // session" scenario (the JWT itself doesn't know the account was
      // just anonymized) — grantRole must now be denied.
      await expect(
        grantRole(prisma, {
          callerId: admin,
          subjectId: subject,
          role: "volunteer",
          scopeType: "global",
          scopeId: null,
        }),
      ).rejects.toThrow(ForbiddenActionError);
    });

    it("rejects a second erasure request while one is already open", async () => {
      const person = track((await createPerson(prisma)).id);
      await prisma.dSARRequest.create({
        data: { id: newId(), personId: person, type: "erasure", status: "pending", requestedBy: person },
      });

      await expect(
        requestErasure(prisma, { personId: person, requestedBy: person }),
      ).rejects.toThrow(OpenDsarRequestExistsError);
    });
  });

  // POST /api/v1/dsar/erasure-requests (identity-access-schema-api.md's
  // REST sketch: "org-admin only, API-key authenticated").
  describe("POST /api/v1/dsar/erasure-requests", () => {
    const originalApiKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    afterAll(() => {
      process.env.ADMIN_API_KEY = originalApiKey;
    });

    it("rejects a request with no API key", async () => {
      const person = track((await createPerson(prisma)).id);
      const response = await postErasureRequest({ personId: person, requestedBy: person }, null);
      expect(response.status).toBe(401);
    });

    it("rejects a request with the wrong API key", async () => {
      const person = track((await createPerson(prisma)).id);
      const response = await postErasureRequest({ personId: person, requestedBy: person }, "wrong-key");
      expect(response.status).toBe(401);
    });

    it("rejects an invalid body", async () => {
      const response = await postErasureRequest({ personId: "not-a-ulid" });
      expect(response.status).toBe(400);
    });

    it("with a valid API key, still enforces can() on requestedBy (403 for a non-admin acting on someone else)", async () => {
      const requester = track((await createPerson(prisma)).id);
      const subject = track((await createPerson(prisma)).id);
      const response = await postErasureRequest({ personId: subject, requestedBy: requester });
      expect(response.status).toBe(403);
    });

    it("with a valid API key and an org_admin requestedBy, anonymizes the person", async () => {
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const subject = track((await createPerson(prisma)).id);

      const response = await postErasureRequest({ personId: subject, requestedBy: admin });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.dsarId).toBeTruthy();

      const row = await prisma.person.findUniqueOrThrow({ where: { id: subject } });
      expect(row.status).toBe("anonymized");
    });
  });
});
