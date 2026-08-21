import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { volunteeringRouter } from "@/server/api/routers/volunteering";
import { createCallerFactory } from "@/server/api/trpc";
import { createPerson, grantRoleDirect, contextFor, createChapterDirect } from "./helpers/identityFixtures";
import {
  createOpportunityDirect,
  createShiftDirect,
  createApplicationDirect,
  createHourEntryDirect,
} from "./helpers/volunteeringFixtures";
import { GET as exportDownloadRoute } from "@/app/api/v1/hour-entries/export/[exportId]/route";
import { GET as exportReportRoute } from "@/app/api/v1/hour-entries/export/route";

// Exercises the volunteering tRPC router built this stage
// (docs/ddd/volunteering-opportunities-schema-api.md's API Contract
// Sketch) end to end against a real Postgres: input validation, the
// `can()`-gated use cases' authorization, the router's own `hours.export`
// check, TRPCError code translation, and the two REST export surfaces —
// via a direct (non-HTTP) caller (`createCallerFactory`) and real
// `NextRequest`s for the route handlers, same shape as
// `identityRouter.integration.test.ts` / `dsar.integration.test.ts`.
describe("volunteeringRouter (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(volunteeringRouter);
  const personIds: string[] = [];
  const opportunityIds: string[] = [];
  const chapterIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);
  const trackOpportunity = (id: string) => (opportunityIds.push(id), id);

  afterAll(async () => {
    await prisma.volunteeringDomainEvent.deleteMany({ where: { aggregateId: { in: opportunityIds } } });
    await prisma.hourEntry.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.application.deleteMany({ where: { shift: { opportunityId: { in: opportunityIds } } } });
    await prisma.shift.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.$disconnect();
  });

  /** A real, active `identity.chapters` row — `PublishOpportunity`'s own precondition checks chapter activity via `identity`'s `listChapters` OHS read, so a plain random ULID `chapterId` (not a real row) fails to publish. */
  async function createActiveChapter() {
    const chapter = await createChapterDirect(prisma);
    chapterIds.push(chapter.id);
    return chapter.id;
  }

  async function makeChapterLead(chapterId: string) {
    const person = await createPerson(prisma);
    track(person.id);
    await grantRoleDirect(prisma, {
      subjectId: person.id,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: chapterId,
      grantedBy: person.id,
    });
    return person;
  }

  async function makeOrgAdmin() {
    const person = await createPerson(prisma);
    track(person.id);
    await grantRoleDirect(prisma, { subjectId: person.id, role: "org_admin", grantedBy: person.id });
    return person;
  }

  function callerFor(person: { id: string; publicSlug: string; displayName: string; avatarUrl: string | null; status: string }) {
    return createCaller(contextFor(prisma, person));
  }

  describe("opportunities", () => {
    it("create requires chapter_lead (own chapter) or org_admin; publish and list follow", async () => {
      const chapterId = await createActiveChapter();
      const lead = await makeChapterLead(chapterId);
      const outsider = track((await createPerson(prisma)).id);
      const outsiderPerson = await prisma.person.findUniqueOrThrow({ where: { id: outsider } });

      await expect(
        callerFor(outsiderPerson).opportunities.create({
          chapterId,
          title: "Denied",
          description: "x",
          category: "event-support",
          skillsRequired: [],
          locationType: "in_person",
          minAge: 16,
          prerequisiteCourseIds: [],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const created = await callerFor(lead).opportunities.create({
        chapterId,
        title: "Beach Cleanup",
        description: "Help clean the beach.",
        category: "event-support",
        skillsRequired: ["outdoors"],
        locationType: "in_person",
        minAge: 16,
        prerequisiteCourseIds: [],
      });
      trackOpportunity(created.opportunityId);

      // Not yet published — invisible to the public `list` default.
      const beforePublish = await callerFor(lead).opportunities.list({});
      expect(beforePublish.items.map((i) => i.opportunityId)).not.toContain(created.opportunityId);

      await callerFor(lead).opportunities.publish({ opportunityId: created.opportunityId });

      const afterPublish = await callerFor(lead).opportunities.list({});
      expect(afterPublish.items.map((i) => i.opportunityId)).toContain(created.opportunityId);

      const fetched = await callerFor(lead).opportunities.getById({ id: created.opportunityId });
      expect(fetched?.status).toBe("published");
    });

    it("search finds a published opportunity by free-text query via the tsvector column", async () => {
      const opportunity = await createOpportunityDirect(prisma, {
        status: "published",
        title: "Riverside Trail Restoration",
      });
      trackOpportunity(opportunity.id);
      const anyone = track((await createPerson(prisma)).id);
      const anyonePerson = await prisma.person.findUniqueOrThrow({ where: { id: anyone } });

      const results = await callerFor(anyonePerson).opportunities.search({ query: "riverside trail" });
      expect(results.map((r) => r.opportunityId)).toContain(opportunity.id);
    });
  });

  describe("shifts + applications: apply, decide, waitlist promotion", () => {
    it("accepts up to capacity, waitlists beyond it, and promotes on withdrawal", async () => {
      const chapterId = newId();
      const lead = await makeChapterLead(chapterId);
      const opportunity = await createOpportunityDirect(prisma, { chapterId, status: "published" });
      trackOpportunity(opportunity.id);

      const shift = await callerFor(lead).shifts.schedule({
        opportunityId: opportunity.id,
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
        timezone: "UTC",
        capacity: 1,
      });

      const first = track((await createPerson(prisma)).id);
      const firstPerson = await prisma.person.findUniqueOrThrow({ where: { id: first } });
      const second = track((await createPerson(prisma)).id);
      const secondPerson = await prisma.person.findUniqueOrThrow({ where: { id: second } });

      const firstApp = await callerFor(firstPerson).applications.applyToShift({ shiftId: shift.shiftId });
      const secondApp = await callerFor(secondPerson).applications.applyToShift({ shiftId: shift.shiftId });

      // Duplicate application while one is already active is rejected.
      await expect(callerFor(firstPerson).applications.applyToShift({ shiftId: shift.shiftId })).rejects.toMatchObject({
        code: "CONFLICT",
      });

      await callerFor(lead).applications.decide({ applicationId: firstApp.applicationId, decision: "accept" });
      // Capacity is 1 and already full — this "accept" request is silently
      // forced to waitlisted (DecideApplication invariant 5), not an error.
      await callerFor(lead).applications.decide({ applicationId: secondApp.applicationId, decision: "accept" });

      const afterDecisions = await callerFor(lead).applications.listForShift({ shiftId: shift.shiftId });
      const byId = Object.fromEntries(afterDecisions.map((a) => [a.applicationId, a.status]));
      expect(byId[firstApp.applicationId]).toBe("accepted");
      expect(byId[secondApp.applicationId]).toBe("waitlisted");

      // Withdrawing the accepted application promotes the waitlisted one.
      await callerFor(firstPerson).applications.withdraw({ applicationId: firstApp.applicationId });

      const afterWithdrawal = await callerFor(lead).applications.listForShift({ shiftId: shift.shiftId });
      const byIdAfter = Object.fromEntries(afterWithdrawal.map((a) => [a.applicationId, a.status]));
      expect(byIdAfter[firstApp.applicationId]).toBe("withdrawn");
      expect(byIdAfter[secondApp.applicationId]).toBe("accepted");
    });

    it("only the applicant may withdraw their own application", async () => {
      const opportunity = await createOpportunityDirect(prisma, { status: "published" });
      trackOpportunity(opportunity.id);
      const shift = await createShiftDirect(prisma, { opportunityId: opportunity.id, capacity: 2 });

      const applicant = track((await createPerson(prisma)).id);
      const applicantPerson = await prisma.person.findUniqueOrThrow({ where: { id: applicant } });
      const other = track((await createPerson(prisma)).id);
      const otherPerson = await prisma.person.findUniqueOrThrow({ where: { id: other } });

      const application = await createApplicationDirect(prisma, { shiftId: shift.id, applicantPersonId: applicant });

      await expect(
        callerFor(otherPerson).applications.withdraw({ applicationId: application.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await expect(
        callerFor(applicantPerson).applications.withdraw({ applicationId: application.id }),
      ).resolves.toBeUndefined();
    });
  });

  describe("hourEntries: submit, approve (immutable), reject", () => {
    it("a submitted hour entry moves to approved with approver/timestamp, then rejects further mutation", async () => {
      const chapterId = newId();
      const lead = await makeChapterLead(chapterId);
      const opportunity = await createOpportunityDirect(prisma, { chapterId, status: "published" });
      trackOpportunity(opportunity.id);

      const volunteer = track((await createPerson(prisma)).id);
      const volunteerPerson = await prisma.person.findUniqueOrThrow({ where: { id: volunteer } });

      const startAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const endAt = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const submitted = await callerFor(volunteerPerson).hourEntries.submit({
        opportunityId: opportunity.id,
        shiftId: null,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        description: "Logged remotely",
      });

      // Self-approval is forbidden even for someone with chapter authority.
      await expect(
        callerFor(volunteerPerson).hourEntries.approve({ hourEntryId: submitted.hourEntryId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await callerFor(lead).hourEntries.approve({ hourEntryId: submitted.hourEntryId });

      const row = await prisma.hourEntry.findUniqueOrThrow({ where: { id: submitted.hourEntryId } });
      expect(row.status).toBe("approved");
      expect(row.approverPersonId).toBe(lead.id);
      expect(row.approvedAt).not.toBeNull();

      // Once approved, a second approve/reject is rejected as a conflict —
      // the row is immutable (ADR-0014).
      await expect(
        callerFor(lead).hourEntries.approve({ hourEntryId: submitted.hourEntryId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        callerFor(lead).hourEntries.reject({ hourEntryId: submitted.hourEntryId, rejectionReason: "too late" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("reject requires a non-empty rejectionReason and records it", async () => {
      const chapterId = newId();
      const lead = await makeChapterLead(chapterId);
      const opportunity = await createOpportunityDirect(prisma, { chapterId, status: "published" });
      trackOpportunity(opportunity.id);
      const volunteer = track((await createPerson(prisma)).id);

      const entry = await createHourEntryDirect(prisma, { personId: volunteer, opportunityId: opportunity.id });

      await callerFor(lead).hourEntries.reject({ hourEntryId: entry.id, rejectionReason: "Duplicate submission." });
      const row = await prisma.hourEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(row.status).toBe("rejected");
      expect(row.rejectionReason).toBe("Duplicate submission.");
    });

    it("listForPerson: self or org_admin only", async () => {
      const opportunity = await createOpportunityDirect(prisma, { status: "published" });
      trackOpportunity(opportunity.id);
      const volunteer = track((await createPerson(prisma)).id);
      const volunteerPerson = await prisma.person.findUniqueOrThrow({ where: { id: volunteer } });
      const stranger = track((await createPerson(prisma)).id);
      const strangerPerson = await prisma.person.findUniqueOrThrow({ where: { id: stranger } });
      await createHourEntryDirect(prisma, { personId: volunteer, opportunityId: opportunity.id });

      await expect(
        callerFor(strangerPerson).hourEntries.listForPerson({ personId: volunteer }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const own = await callerFor(volunteerPerson).hourEntries.listForPerson({ personId: volunteer });
      expect(own.length).toBeGreaterThan(0);
    });
  });

  describe("hourEntries.exportApproved + REST export surfaces", () => {
    it("requires hours.export authority, and returns a downloadable csvUrl matching the query summary", async () => {
      const chapterId = newId();
      const lead = await makeChapterLead(chapterId);
      const outsiderChapterLead = await makeChapterLead(newId());
      const opportunity = await createOpportunityDirect(prisma, { chapterId, status: "published" });
      trackOpportunity(opportunity.id);
      const volunteer = track((await createPerson(prisma)).id);
      const approvedAt = new Date();
      await createHourEntryDirect(prisma, {
        personId: volunteer,
        opportunityId: opportunity.id,
        status: "approved",
        approverPersonId: lead.id,
        approvedAt,
        durationMinutes: 120,
      });

      const fromDate = new Date(approvedAt.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const toDate = new Date(approvedAt.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      // A chapter_lead scoped to a *different* chapter is denied.
      await expect(
        callerFor(outsiderChapterLead).hourEntries.exportApproved({ chapterId, fromDate, toDate }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const result = await callerFor(lead).hourEntries.exportApproved({
        chapterId,
        fromDate,
        toDate,
        hourlyRate: 10,
      });
      expect(result.totalHours).toBe(2);
      expect(result.totalValue).toBe(20);
      expect(result.csvUrl).toMatch(/^\/api\/v1\/hour-entries\/export\/.+\?token=/);

      // The signed URL is independently downloadable.
      const url = new URL(result.csvUrl, "http://localhost");
      const exportId = url.pathname.split("/").pop()!;
      const response = await exportDownloadRoute(new NextRequest(url), {
        params: Promise.resolve({ exportId }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      const csvBody = await response.text();
      expect(csvBody).toContain(volunteer);

      // Tampered token is rejected.
      const tamperedUrl = new URL(result.csvUrl, "http://localhost");
      tamperedUrl.searchParams.set("token", tamperedUrl.searchParams.get("token") + "x");
      const tamperedResponse = await exportDownloadRoute(new NextRequest(tamperedUrl), {
        params: Promise.resolve({ exportId }),
      });
      expect(tamperedResponse.status).toBe(403);
    });

    it("an unfiltered (org-wide) export requires org_admin, not a chapter_lead", async () => {
      const chapterId = newId();
      const lead = await makeChapterLead(chapterId);
      await expect(
        callerFor(lead).hourEntries.exportApproved({ fromDate: "2026-01-01", toDate: "2026-12-31" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const admin = await makeOrgAdmin();
      await expect(
        callerFor(admin).hourEntries.exportApproved({ fromDate: "2026-01-01", toDate: "2026-12-31" }),
      ).resolves.toMatchObject({ totalHours: expect.any(Number) });
    });
  });

  describe("GET /api/v1/hour-entries/export (REST, API-key authenticated)", () => {
    const TEST_ADMIN_API_KEY = "test-admin-api-key-for-volunteering-export-suite";
    const originalApiKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    afterAll(() => {
      process.env.ADMIN_API_KEY = originalApiKey;
    });

    function reportUrl(params: Record<string, string>) {
      const url = new URL("http://localhost/api/v1/hour-entries/export");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    }

    it("rejects a request with no/wrong API key", async () => {
      const url = reportUrl({ from: "2026-01-01", to: "2026-12-31" });
      const noKey = await exportReportRoute(new NextRequest(url));
      expect(noKey.status).toBe(401);

      const wrongKey = await exportReportRoute(
        new NextRequest(url, { headers: { "x-api-key": "wrong" } }),
      );
      expect(wrongKey.status).toBe(401);
    });

    it("rejects invalid query parameters", async () => {
      const url = reportUrl({ from: "not-a-date", to: "2026-12-31" });
      const response = await exportReportRoute(
        new NextRequest(url, { headers: { "x-api-key": TEST_ADMIN_API_KEY } }),
      );
      expect(response.status).toBe(400);
    });

    it("returns CSV by default and PDF when format=pdf", async () => {
      const opportunity = await createOpportunityDirect(prisma, { status: "published" });
      trackOpportunity(opportunity.id);
      const volunteer = track((await createPerson(prisma)).id);
      const lead = await makeOrgAdmin();
      const approvedAt = new Date();
      await createHourEntryDirect(prisma, {
        personId: volunteer,
        opportunityId: opportunity.id,
        status: "approved",
        approverPersonId: lead.id,
        approvedAt,
        durationMinutes: 60,
      });
      const fromDate = new Date(approvedAt.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const toDate = new Date(approvedAt.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const csvResponse = await exportReportRoute(
        new NextRequest(reportUrl({ from: fromDate, to: toDate }), {
          headers: { "x-api-key": TEST_ADMIN_API_KEY },
        }),
      );
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers.get("content-type")).toContain("text/csv");
      expect(await csvResponse.text()).toContain(volunteer);

      const pdfResponse = await exportReportRoute(
        new NextRequest(reportUrl({ from: fromDate, to: toDate, format: "pdf" }), {
          headers: { "x-api-key": TEST_ADMIN_API_KEY },
        }),
      );
      expect(pdfResponse.status).toBe(200);
      expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
      const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
      expect(pdfBytes.toString("latin1", 0, 8)).toBe("%PDF-1.4");
    });
  });
});
