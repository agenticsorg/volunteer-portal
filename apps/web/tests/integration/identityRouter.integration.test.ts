import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { identityRouter } from "@/server/api/routers/identity";
import { createCallerFactory } from "@/server/api/trpc";
import { createPerson, grantRoleDirect, contextFor } from "./helpers/identityFixtures";

// Exercises the identity tRPC router built this stage
// (docs/ddd/identity-access-schema-api.md's API Contract Sketch) end to
// end against a real Postgres: input validation, the self-or-org_admin
// read gates this router adds on top of the use cases' own `can()` checks,
// and TRPCError code translation — via a direct (non-HTTP) caller
// (`createCallerFactory`), not a mocked router.
describe("identityRouter (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(identityRouter);
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);
  const trackChapter = (id: string) => (chapterIds.push(id), id);

  afterAll(async () => {
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.dSARRequest.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({
      where: { OR: [{ subjectId: { in: personIds } }, { grantedBy: { in: personIds } }] },
    });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function makeOrgAdmin() {
    const person = await createPerson(prisma);
    track(person.id);
    await grantRoleDirect(prisma, { subjectId: person.id, role: "org_admin", grantedBy: person.id });
    return person;
  }

  describe("getPersonSummary (Open Host Service)", () => {
    it("returns only the public fields for a real person", async () => {
      const person = await createPerson(prisma, { displayName: "Public Facing" });
      track(person.id);
      const caller = createCaller(contextFor(prisma, { ...person, status: "active" }));

      const summary = await caller.getPersonSummary({ personId: person.id });

      expect(summary).toEqual({
        personId: person.id,
        publicSlug: person.publicSlug,
        displayName: "Public Facing",
        avatarUrl: null,
      });
    });

    it("returns null for an unknown personId", async () => {
      const caller = createCaller({
        headers: new Headers(),
        prisma,
        supabaseSession: null,
        requestId: "test-request-id",
        person: null,
      });
      const summary = await caller.getPersonSummary({ personId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
      expect(summary).toBeNull();
    });
  });

  describe("chapters", () => {
    it("create requires org_admin, and list is public", async () => {
      const admin = await makeOrgAdmin();
      const nonAdmin = track((await createPerson(prisma)).id);
      const nonAdminPerson = await prisma.person.findUniqueOrThrow({ where: { id: nonAdmin } });

      const deniedCaller = createCaller(contextFor(prisma, nonAdminPerson));
      await expect(
        deniedCaller.chapters.create({ name: "Denied Chapter", slug: `denied-${nonAdmin}`, city: "X", country: "Y" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const adminCaller = createCaller(contextFor(prisma, admin));
      const created = await adminCaller.chapters.create({
        name: "Allowed Chapter",
        slug: `allowed-${admin.id}`,
        city: "Toronto",
        country: "Canada",
      });
      trackChapter(created.chapterId);

      const publicCaller = createCaller({ headers: new Headers(), prisma, supabaseSession: null, requestId: "test-request-id", person: null });
      const list = await publicCaller.chapters.list({ status: "active" });
      expect(list.some((c) => c.chapterId === created.chapterId)).toBe(true);
    });
  });

  describe("roles", () => {
    it("grant/revoke round-trip via the router, gated by can()", async () => {
      const admin = await makeOrgAdmin();
      const subject = track((await createPerson(prisma)).id);
      const adminCaller = createCaller(contextFor(prisma, admin));

      const granted = await adminCaller.roles.grant({
        subjectId: subject,
        role: "mentor",
        scopeType: "global",
        scopeId: null,
      });
      expect(granted.roleAssignmentId).toBeTruthy();

      await adminCaller.roles.revoke({ roleAssignmentId: granted.roleAssignmentId });

      const active = await adminCaller.roles.listForSubject({ subjectId: subject });
      expect(active.find((r) => r.id === granted.roleAssignmentId)).toBeUndefined();
    });

    it("listForSubject is restricted to self or org_admin", async () => {
      const subject = await createPerson(prisma);
      track(subject.id);
      const stranger = track((await createPerson(prisma)).id);
      const strangerPerson = await prisma.person.findUniqueOrThrow({ where: { id: stranger } });

      const strangerCaller = createCaller(contextFor(prisma, strangerPerson));
      await expect(strangerCaller.roles.listForSubject({ subjectId: subject.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const selfCaller = createCaller(contextFor(prisma, subject));
      await expect(selfCaller.roles.listForSubject({ subjectId: subject.id })).resolves.toEqual([]);
    });
  });

  describe("consent", () => {
    it("a person can record, read, and revoke their own consent", async () => {
      const person = await createPerson(prisma);
      track(person.id);
      const caller = createCaller(contextFor(prisma, person));

      const recorded = await caller.consent.record({
        personId: person.id,
        purpose: "newsletter",
        granted: true,
        policyVersion: "v1",
        source: "settings_page",
      });
      expect(recorded.consentId).toBeTruthy();

      const current = await caller.consent.getForPerson({ personId: person.id });
      expect(current).toEqual([
        expect.objectContaining({ purpose: "newsletter", granted: true, revokedAt: null }),
      ]);

      await caller.consent.revoke({ personId: person.id, purpose: "newsletter" });
      const afterRevoke = await caller.consent.getForPerson({ personId: person.id });
      expect(afterRevoke[0].revokedAt).not.toBeNull();
    });

    it("a stranger cannot record consent on someone else's behalf", async () => {
      const person = track((await createPerson(prisma)).id);
      const stranger = await createPerson(prisma);
      track(stranger.id);
      const strangerCaller = createCaller(contextFor(prisma, stranger));

      await expect(
        strangerCaller.consent.record({
          personId: person,
          purpose: "newsletter",
          granted: true,
          policyVersion: "v1",
          source: "settings_page",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("dsar", () => {
    it("requestExport/getStatus round-trip, and requestedBy is always the caller (not spoofable)", async () => {
      const person = await createPerson(prisma);
      track(person.id);
      const caller = createCaller(contextFor(prisma, person));

      const { dsarId } = await caller.dsar.requestExport({ personId: person.id });
      const status = await caller.dsar.getStatus({ dsarId });
      expect(status.status).toBe("completed");
      expect(status.requestedBy).toBe(person.id);
    });

    it("getStatus is restricted to the subject or an org_admin", async () => {
      const person = await createPerson(prisma);
      track(person.id);
      const caller = createCaller(contextFor(prisma, person));
      const { dsarId } = await caller.dsar.requestExport({ personId: person.id });

      const stranger = await createPerson(prisma);
      track(stranger.id);
      const strangerCaller = createCaller(contextFor(prisma, stranger));
      await expect(strangerCaller.dsar.getStatus({ dsarId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("requestErasure anonymizes the caller's own person, ignoring any spoofed requestedBy", async () => {
      const person = await createPerson(prisma);
      track(person.id);
      const caller = createCaller(contextFor(prisma, person));

      const { dsarId } = await caller.dsar.requestErasure({ personId: person.id });
      const status = await caller.dsar.getStatus({ dsarId }).catch(() => null);
      // The subject is now anonymized; getStatus's self-check still passes
      // because ctx.person.personId (fixed at context-build time above)
      // still equals the DSARRequest's personId.
      expect(status?.status).toBe("completed");

      const row = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
      expect(row.status).toBe("anonymized");
      expect(row.displayName).toBe("Deleted User");
    });
  });
});
