import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReportDefinition,
  requestExportJob,
  getExportDownloadUrl,
  ExportJobDownloadExpiredError,
  ExportJobNotDownloadableError,
  ExportJobNotFoundError,
  ForbiddenActionError,
} from "@/modules/admin";
import { createPerson, createChapterDirect, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject, createOpportunityDirect, createHourEntryDirect } from "./helpers/volunteeringFixtures";

const R2_ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

function setFakeR2Env() {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.R2_BUCKET = "test-exports-bucket";
  process.env.R2_ACCESS_KEY_ID = "test-access-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
}

// `resolveRequestPerson` (`server/auth/session-person.ts`) resolves a
// `Person` from a real, cryptographically verified Supabase session in
// production (see `verifiedSession.test.ts`'s own header on why that
// crypto itself isn't re-proven here) — this suite fakes only the one
// boundary call CI has no live Supabase stack for (`@supabase/ssr`'s
// `createServerClient(...).auth.getClaims()`), driven by `currentAuthId`
// below, and otherwise runs the exact real `findPersonByAuthId` DB lookup
// and real `GetExportDownloadUrl`/`getExportJob` use cases these two REST
// routes wrap.
let currentAuthId: string | null = null;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getClaims: async () =>
        currentAuthId
          ? {
              data: {
                claims: { sub: currentAuthId, email: "admin-export-route-test@example.com" },
                header: { alg: "ES256", kid: "k1", typ: "JWT" },
                signature: new Uint8Array(),
              },
              error: null,
            }
          : { data: null, error: { message: "no session" } },
    },
  }),
  parseCookieHeader: () => [],
}));

const { GET: pollExportJobRoute } = await import("@/app/api/v1/admin/exports/[exportJobId]/route");
const { GET: downloadExportRoute } = await import("@/app/api/v1/admin/exports/[exportJobId]/download/route");

function requestFor(exportJobId: string, path: "" | "/download" = "") {
  return new NextRequest(new URL(`http://localhost/api/v1/admin/exports/${exportJobId}${path}`));
}

// Exercises `GetExportDownloadUrl` (Key Use Case 7) and its two REST
// routes end to end: session resolution, `can()`'s "original requester or
// org_admin" ownership rule, the `completed`/`outputFileExpiresAt`
// preconditions (404/410), and the real SigV4-presigned R2 GET URL a
// successful call redirects to.
describe("GetExportDownloadUrl + GET /api/v1/admin/exports/:exportJobId(/download) (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const opportunityIds: string[] = [];
  const reportDefinitionIds: string[] = [];
  const exportJobIds: string[] = [];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    currentAuthId = null;
    for (const key of R2_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });

  afterEach(() => {
    for (const key of R2_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.adminDomainEvent.deleteMany({ where: { aggregateId: { in: exportJobIds } } });
    await prisma.exportJob.deleteMany({ where: { id: { in: exportJobIds } } });
    await prisma.reportDefinition.deleteMany({ where: { id: { in: reportDefinitionIds } } });
    await prisma.hourEntry.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function orgAdmin() {
    const p = await createPerson(prisma, { displayName: "Export Download Admin" });
    personIds.push(p.id);
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function volunteer(displayName: string) {
    const p = await createPerson(prisma, { displayName });
    personIds.push(p.id);
    return p;
  }

  async function completedGrantReportJob(requestedBy: { id: string; status: string }) {
    setFakeR2Env();
    const chapter = await createChapterDirect(prisma, { name: "Download Test Chapter" });
    chapterIds.push(chapter.id);
    const opportunity = await createOpportunityDirect(prisma, { chapterId: chapter.id });
    opportunityIds.push(opportunity.id);
    const hoursVolunteer = await volunteer("Download Test Volunteer");
    await createHourEntryDirect(prisma, {
      personId: hoursVolunteer.id,
      opportunityId: opportunity.id,
      status: "approved",
      durationMinutes: 60,
      approverPersonId: requestedBy.id,
      approvedAt: new Date(),
    });
    const definition = await createReportDefinition(prisma, {
      caller: callerSubject(requestedBy),
      name: "Download Test Report",
      reportType: "approved_hours_summary",
      filters: { chapterIds: [chapter.id], dateRangeMode: "fixed", fromDate: "2020-01-01", toDate: "2030-01-01" },
      outputFormats: ["csv"],
    });
    reportDefinitionIds.push(definition.id);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const run = await requestExportJob(prisma, {
      caller: callerSubject(requestedBy),
      type: "grant_report",
      reportDefinitionId: definition.id,
    });
    exportJobIds.push(run.exportJobId);
    expect(run.status).toBe("completed");
    return run.exportJobId;
  }

  describe("getExportDownloadUrl (application layer)", () => {
    it("mints a real presigned R2 GET URL for the org_admin who requested it", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);

      const result = await getExportDownloadUrl(prisma, { caller: callerSubject(admin), exportJobId });
      expect(result.url).toMatch(/^https:\/\/test-account\.r2\.cloudflarestorage\.com\/test-exports-bucket\//);
      expect(result.url).toContain("X-Amz-Signature=");
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("allows the original (non-admin) requester to download their own export", async () => {
      const admin = await orgAdmin();
      const requester = await volunteer("Self Requester");
      // Only an org_admin can call requestExportJob (`export.request`), but
      // `export.download`'s ownership check keys off `requestedByPersonId`
      // on the row itself — set it directly to the non-admin requester to
      // isolate that ownership branch from the separate `export.request`
      // authority check already covered elsewhere.
      const exportJobId = await completedGrantReportJob(admin);
      await prisma.exportJob.update({ where: { id: exportJobId }, data: { requestedByPersonId: requester.id } });

      const result = await getExportDownloadUrl(prisma, { caller: callerSubject(requester), exportJobId });
      expect(result.url).toContain("X-Amz-Signature=");
    });

    it("denies a caller who is neither the original requester nor an org_admin", async () => {
      const admin = await orgAdmin();
      const outsider = await volunteer("Outsider");
      const exportJobId = await completedGrantReportJob(admin);

      await expect(
        getExportDownloadUrl(prisma, { caller: callerSubject(outsider), exportJobId }),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it("rejects an unknown exportJobId", async () => {
      const admin = await orgAdmin();
      await expect(
        getExportDownloadUrl(prisma, { caller: callerSubject(admin), exportJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      ).rejects.toBeInstanceOf(ExportJobNotFoundError);
    });

    it("rejects a job that is not yet completed", async () => {
      const admin = await orgAdmin();
      const definition = await createReportDefinition(prisma, {
        caller: callerSubject(admin),
        name: "Still Queued Report",
        reportType: "approved_hours_summary",
        filters: { dateRangeMode: "fixed", fromDate: "2020-01-01", toDate: "2030-01-01" },
      });
      reportDefinitionIds.push(definition.id);
      // No R2 env configured -> the synchronous run fails, but for this
      // test we only need a row that never reached `completed`.
      const run = await requestExportJob(prisma, {
        caller: callerSubject(admin),
        type: "grant_report",
        reportDefinitionId: definition.id,
      });
      exportJobIds.push(run.exportJobId);
      expect(run.status).toBe("failed");

      await expect(
        getExportDownloadUrl(prisma, { caller: callerSubject(admin), exportJobId: run.exportJobId }),
      ).rejects.toBeInstanceOf(ExportJobNotDownloadableError);
    });

    it("rejects a completed job whose download link has expired", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);
      await prisma.exportJob.update({
        where: { id: exportJobId },
        data: { outputFileExpiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        getExportDownloadUrl(prisma, { caller: callerSubject(admin), exportJobId }),
      ).rejects.toBeInstanceOf(ExportJobDownloadExpiredError);
    });
  });

  describe("GET /api/v1/admin/exports/:exportJobId/download", () => {
    it("returns 401 with no session", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);
      currentAuthId = null;

      const response = await downloadExportRoute(requestFor(exportJobId, "/download"), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(401);
    });

    it("302-redirects an org_admin to the real presigned R2 URL, never returning it as JSON", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);
      currentAuthId = admin.supabaseAuthId;

      const response = await downloadExportRoute(requestFor(exportJobId, "/download"), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toMatch(/^https:\/\/test-account\.r2\.cloudflarestorage\.com\//);
      expect(location).toContain("X-Amz-Signature=");
    });

    it("returns 403 for a caller who is neither the requester nor org_admin", async () => {
      const admin = await orgAdmin();
      const outsider = await volunteer("Route Outsider");
      const exportJobId = await completedGrantReportJob(admin);
      currentAuthId = outsider.supabaseAuthId;

      const response = await downloadExportRoute(requestFor(exportJobId, "/download"), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(403);
    });

    it("returns 410 once the download link has expired", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);
      await prisma.exportJob.update({
        where: { id: exportJobId },
        data: { outputFileExpiresAt: new Date(Date.now() - 1000) },
      });
      currentAuthId = admin.supabaseAuthId;

      const response = await downloadExportRoute(requestFor(exportJobId, "/download"), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(410);
    });

    it("returns 404 for an unknown exportJobId", async () => {
      const admin = await orgAdmin();
      currentAuthId = admin.supabaseAuthId;

      const response = await downloadExportRoute(requestFor("01ARZ3NDEKTSV4RRFFQ69G5FAV", "/download"), {
        params: Promise.resolve({ exportJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/v1/admin/exports/:exportJobId (polling)", () => {
    it("returns 401 with no session", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);
      currentAuthId = null;

      const response = await pollExportJobRoute(requestFor(exportJobId), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(401);
    });

    it("returns status/rowCount/outputFileFormat/outputFileExpiresAt for an org_admin", async () => {
      const admin = await orgAdmin();
      const exportJobId = await completedGrantReportJob(admin);
      currentAuthId = admin.supabaseAuthId;

      const response = await pollExportJobRoute(requestFor(exportJobId), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ status: "completed", rowCount: 1, outputFileFormat: "csv" });
      expect(typeof body.outputFileExpiresAt).toBe("string");
    });

    it("returns 403 for a non-org_admin caller (export.request is org_admin-only, unlike export.download's ownership branch)", async () => {
      const admin = await orgAdmin();
      const requester = await volunteer("Polling Non-Admin");
      const exportJobId = await completedGrantReportJob(admin);
      await prisma.exportJob.update({ where: { id: exportJobId }, data: { requestedByPersonId: requester.id } });
      currentAuthId = requester.supabaseAuthId;

      const response = await pollExportJobRoute(requestFor(exportJobId), {
        params: Promise.resolve({ exportJobId }),
      });
      expect(response.status).toBe(403);
    });

    it("returns 404 for an unknown exportJobId", async () => {
      const admin = await orgAdmin();
      currentAuthId = admin.supabaseAuthId;

      const response = await pollExportJobRoute(requestFor("01ARZ3NDEKTSV4RRFFQ69G5FAV"), {
        params: Promise.resolve({ exportJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      });
      expect(response.status).toBe(404);
    });
  });
});
