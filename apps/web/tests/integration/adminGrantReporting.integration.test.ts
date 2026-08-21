import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReportDefinition,
  updateReportDefinition,
  requestExportJob,
  getExportJob,
  getReportDefinition,
  ForbiddenActionError,
  ReportDefinitionNotActiveError,
} from "@/modules/admin";
import { createPerson, createChapterDirect, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject, createOpportunityDirect, createHourEntryDirect } from "./helpers/volunteeringFixtures";

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

function setFakeR2Env() {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.R2_BUCKET = "test-exports-bucket";
  process.env.R2_ACCESS_KEY_ID = "test-access-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
}

/**
 * `cloudflareR2Adapter.uploadExportFile` hands `fetch` a real, server-signed
 * PUT with `body: new Uint8Array(bytes)` (the CSV `ProcessExportJob` itself
 * rendered) — decoding that back to text is how these tests read a grant
 * report's REAL dollar figures without a live R2 bucket, per this phase's
 * own brief: "build everything for real EXCEPT the literal external HTTP
 * call."
 */
function decodeUploadedCsv(body: unknown): string {
  return Buffer.from(body as Uint8Array).toString("utf8");
}

// Exercises RequestExportJob / ProcessExportJob (docs/ddd/admin-reporting.md
// Key Use Cases 3/5) end to end against a real Postgres, with the R2 PUT
// itself mocked (this environment has no live R2 credentials — see
// modules/admin/infra/cloudflareR2Client.ts's own header comment) — and,
// specifically, the phase's one load-bearing invariant: a grant report's
// own stored `params.hourlyValuationRateCents` and rendered output are
// fixed at generation time and never silently change if the underlying
// `ReportDefinition`'s rate is edited afterward (Phase 9's "Do not consider
// this phase complete until" bar, first bullet).
describe("Admin grant reporting — ReportDefinition/ExportJob lifecycle, snapshotted valuation rate (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const opportunityIds: string[] = [];
  const reportDefinitionIds: string[] = [];
  const exportJobIds: string[] = [];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
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
    const p = await createPerson(prisma, { displayName: "Grant Report Admin" });
    personIds.push(p.id);
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function volunteer(displayName: string) {
    const p = await createPerson(prisma, { displayName });
    personIds.push(p.id);
    return p;
  }

  it("snapshots the hourly valuation rate at request time — editing the ReportDefinition afterward never changes an already-completed report's stored figures or file", async () => {
    setFakeR2Env();
    const org = await orgAdmin();
    const vol = await volunteer("Approved Hours Volunteer");
    const chapter = await createChapterDirect(prisma, { name: "Snapshot Chapter" });
    chapterIds.push(chapter.id);
    const opportunity = await createOpportunityDirect(prisma, { chapterId: chapter.id });
    opportunityIds.push(opportunity.id);
    await createHourEntryDirect(prisma, {
      personId: vol.id,
      opportunityId: opportunity.id,
      status: "approved",
      durationMinutes: 120, // 2 hours
      approverPersonId: org.id,
      approvedAt: new Date(),
    });

    const definition = await createReportDefinition(prisma, {
      caller: callerSubject(org),
      name: "Snapshot Test Report",
      reportType: "approved_hours_summary",
      filters: {
        chapterIds: [chapter.id],
        dateRangeMode: "fixed",
        fromDate: "2020-01-01",
        toDate: "2030-01-01",
      },
      hourlyValuationRateCents: 3614,
      outputFormats: ["csv"],
    });
    reportDefinitionIds.push(definition.id);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const firstRun = await requestExportJob(prisma, {
      caller: callerSubject(org),
      type: "grant_report",
      reportDefinitionId: definition.id,
    });
    exportJobIds.push(firstRun.exportJobId);
    expect(firstRun.status).toBe("completed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const firstJob = await getExportJob(prisma, { caller: callerSubject(org), id: firstRun.exportJobId });
    expect(firstJob.status).toBe("completed");
    expect(firstJob.rowCount).toBe(1);
    expect((firstJob.params as Record<string, unknown>).hourlyValuationRateCents).toBe(3614);
    const firstOutputFileKey = firstJob.outputFileKey;
    expect(firstOutputFileKey).toBe(`exports/grant-reports/${chapter.id}/${firstRun.exportJobId}.csv`);

    // 2 hours * $36.14/hr = $72.28 — the dollar figure this run's stored
    // file actually carries, read from the REAL bytes handed to the
    // (network-mocked) R2 PUT — `renderCsv`'s own real rendering/valuation
    // logic, not a synthetic assertion.
    const firstCsv = decodeUploadedCsv(fetchSpy.mock.calls[0]![1]!.body);
    expect(firstCsv).toContain("72.28 USD");

    // Edit the ReportDefinition's rate AFTER the report has already
    // completed — invariant 1's whole point.
    await updateReportDefinition(prisma, {
      caller: callerSubject(org),
      id: definition.id,
      hourlyValuationRateCents: 5000,
    });
    const editedDefinition = await getReportDefinition(prisma, { caller: callerSubject(org), id: definition.id });
    expect(editedDefinition.hourlyValuationRateCents).toBe(5000);

    // Re-read the ALREADY-COMPLETED report: its own stored params/output
    // must be identical to what they were the moment it completed — never
    // silently re-derived from the definition's new rate.
    const rereadJob = await getExportJob(prisma, { caller: callerSubject(org), id: firstRun.exportJobId });
    expect(rereadJob.status).toBe("completed");
    expect((rereadJob.params as Record<string, unknown>).hourlyValuationRateCents).toBe(3614);
    expect(rereadJob.outputFileKey).toBe(firstOutputFileKey);
    expect(rereadJob.rowCount).toBe(1);
    expect(rereadJob.completedAt).toBe(firstJob.completedAt);

    // A brand-new run against the same (now-edited) definition correctly
    // picks up the NEW rate — proving the definition's edit isn't inert,
    // only that it can never reach backward into a prior run's own figures.
    const secondRun = await requestExportJob(prisma, {
      caller: callerSubject(org),
      type: "grant_report",
      reportDefinitionId: definition.id,
    });
    exportJobIds.push(secondRun.exportJobId);
    expect(secondRun.status).toBe("completed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const secondJob = await getExportJob(prisma, { caller: callerSubject(org), id: secondRun.exportJobId });
    expect((secondJob.params as Record<string, unknown>).hourlyValuationRateCents).toBe(5000);
    // 2 hours * $50.00/hr = $100.00, for the SAME underlying hour entry.
    const secondCsv = decodeUploadedCsv(fetchSpy.mock.calls[1]![1]!.body);
    expect(secondCsv).toContain("100.00 USD");

    // And, once more: the FIRST job's own params are still completely
    // untouched by either the edit or the second run.
    const firstJobAgain = await getExportJob(prisma, { caller: callerSubject(org), id: firstRun.exportJobId });
    expect((firstJobAgain.params as Record<string, unknown>).hourlyValuationRateCents).toBe(3614);
  });

  it("rejects RequestExportJob from a caller who is not an org_admin", async () => {
    const nonAdmin = await volunteer("Not An Admin");
    await expect(
      requestExportJob(prisma, { caller: callerSubject(nonAdmin), type: "custom", customParams: {} }),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });

  it("rejects requesting a grant_report against a disabled (isActive: false) ReportDefinition", async () => {
    const org = await orgAdmin();
    const definition = await createReportDefinition(prisma, {
      caller: callerSubject(org),
      name: "Disabled Report",
      reportType: "approved_hours_summary",
      filters: { dateRangeMode: "fixed", fromDate: "2020-01-01", toDate: "2030-01-01" },
    });
    reportDefinitionIds.push(definition.id);
    await updateReportDefinition(prisma, { caller: callerSubject(org), id: definition.id, isActive: false });

    await expect(
      requestExportJob(prisma, { caller: callerSubject(org), type: "grant_report", reportDefinitionId: definition.id }),
    ).rejects.toBeInstanceOf(ReportDefinitionNotActiveError);
  });

  it("a grant_report ExportJob fails cleanly (never a fake success) when R2 is not configured — this environment truly has no R2 credentials", async () => {
    // No setFakeR2Env() here — beforeEach already deleted every R2 env var,
    // reproducing this environment's real, documented state.
    const org = await orgAdmin();
    const chapter = await createChapterDirect(prisma, { name: "Unconfigured R2 Chapter" });
    chapterIds.push(chapter.id);
    const definition = await createReportDefinition(prisma, {
      caller: callerSubject(org),
      name: "Unconfigured R2 Report",
      reportType: "approved_hours_summary",
      filters: { chapterIds: [chapter.id], dateRangeMode: "fixed", fromDate: "2020-01-01", toDate: "2030-01-01" },
      outputFormats: ["csv"],
    });
    reportDefinitionIds.push(definition.id);

    const result = await requestExportJob(prisma, {
      caller: callerSubject(org),
      type: "grant_report",
      reportDefinitionId: definition.id,
    });
    exportJobIds.push(result.exportJobId);
    expect(result.status).toBe("failed");

    const job = await getExportJob(prisma, { caller: callerSubject(org), id: result.exportJobId });
    expect(job.status).toBe("failed");
    expect(job.errorMessage).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
  });
});
