import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { runRetentionSweep } from "@/modules/admin";
import { createPerson } from "./helpers/identityFixtures";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

// Exercises `runRetentionSweep` (ADR-0014 §3; docs/ddd/admin-reporting.md's
// `RetentionPolicyExpired` event) against a real Postgres, against the
// REAL seeded `admin.retention_policies` rows (migration
// `20260821060000_add_admin_retention_policies` — `inactive_volunteer_pii`
// = 730 days, `moderation_logs` = 1095 days, `dsar_export_bundles` = 7
// days, plus `video_watch_events`/`session_tokens`, both intentionally
// unhandled this phase). Phase 9's "Do not consider this phase complete
// until" bar's fourth bullet: "the retention sweep, run against seeded
// stale data, anonymizes/deletes exactly the rows past their retention
// window and leaves rows still inside the window untouched (test BOTH
// sides of that boundary explicitly)."
//
// Each test below plants one row 1 minute PAST its data class's own cutoff
// and one row 1 minute INSIDE it (i.e. not yet stale), fixes `now` once,
// and asserts each row's fate individually by id — never by trusting an
// aggregate `affectedCount`, since `runRetentionSweep` sweeps every
// enabled policy platform-wide in one call and this shared testcontainers
// Postgres may carry unrelated rows from other concurrently-running
// integration test files.
describe("Admin retention sweep — runRetentionSweep, per-data-class boundary (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const reportIds: string[] = [];

  afterAll(async () => {
    await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  it("inactive_volunteer_pii (730 days): anonymizes a Person whose updated_at is just past the cutoff, leaves one just inside it untouched", async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 730 * MS_PER_DAY);

    const justPast = await createPerson(prisma, { displayName: "Just Past The Retention Window" });
    const justInside = await createPerson(prisma, { displayName: "Just Inside The Retention Window" });
    personIds.push(justPast.id, justInside.id);

    await prisma.person.update({
      where: { id: justPast.id },
      data: { updatedAt: new Date(cutoff.getTime() - ONE_MINUTE_MS) },
    });
    await prisma.person.update({
      where: { id: justInside.id },
      data: { updatedAt: new Date(cutoff.getTime() + ONE_MINUTE_MS) },
    });

    const { results } = await runRetentionSweep(prisma, now);

    const sweptPast = await prisma.person.findUniqueOrThrow({ where: { id: justPast.id } });
    expect(sweptPast.status).toBe("anonymized");
    expect(sweptPast.displayName).toBe("Deleted User");
    expect(sweptPast.email).toBe(`anonymized+${justPast.id.toLowerCase()}@volunteer-portal.invalid`);
    expect(sweptPast.anonymizedAt).not.toBeNull();

    const untouchedInside = await prisma.person.findUniqueOrThrow({ where: { id: justInside.id } });
    expect(untouchedInside.status).toBe("active");
    expect(untouchedInside.displayName).toBe("Just Inside The Retention Window");
    expect(untouchedInside.anonymizedAt).toBeNull();

    const inactiveResult = results.find((r) => r.dataClass === "inactive_volunteer_pii");
    expect(inactiveResult).toMatchObject({ dataClass: "inactive_volunteer_pii", action: "anonymize", skipped: false });
    expect(inactiveResult!.affectedCount).toBeGreaterThanOrEqual(1);
  });

  it("moderation_logs (1095 days): anonymizes a Report's reporter reference just past the cutoff, leaves one just inside it untouched — action/reason retained either way", async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 1095 * MS_PER_DAY);

    const reporter = await createPerson(prisma, { displayName: "Moderation Sweep Reporter" });
    personIds.push(reporter.id);

    const reportJustPast = await prisma.report.create({
      data: {
        id: newId(),
        reporterPersonId: reporter.id,
        reportedEntityType: "identity.person",
        reportedEntityId: newId(),
        reason: "spam",
        status: "resolved",
        scopeType: "org",
        createdAt: new Date(cutoff.getTime() - ONE_MINUTE_MS),
      },
    });
    const reportJustInside = await prisma.report.create({
      data: {
        id: newId(),
        reporterPersonId: reporter.id,
        reportedEntityType: "identity.person",
        reportedEntityId: newId(),
        reason: "spam",
        status: "resolved",
        scopeType: "org",
        createdAt: new Date(cutoff.getTime() + ONE_MINUTE_MS),
      },
    });
    reportIds.push(reportJustPast.id, reportJustInside.id);

    const { results } = await runRetentionSweep(prisma, now);

    const sweptPast = await prisma.report.findUniqueOrThrow({ where: { id: reportJustPast.id } });
    expect(sweptPast.reporterPersonId).toMatch(/^anon_/);
    expect(sweptPast.reason).toBe("spam"); // "retain action/reason" — only the actor reference is anonymized.

    const untouchedInside = await prisma.report.findUniqueOrThrow({ where: { id: reportJustInside.id } });
    expect(untouchedInside.reporterPersonId).toBe(reporter.id);

    const moderationResult = results.find((r) => r.dataClass === "moderation_logs");
    expect(moderationResult).toMatchObject({ dataClass: "moderation_logs", action: "anonymize", skipped: false });
    expect(moderationResult!.affectedCount).toBeGreaterThanOrEqual(1);
  });

  it("reports every seeded data class exactly once, marking the two with no owning-schema handler this phase as skipped (never silently dropped, never faked)", async () => {
    const { results } = await runRetentionSweep(prisma, new Date());
    const byDataClass = new Map(results.map((r) => [r.dataClass, r]));

    expect(byDataClass.get("inactive_volunteer_pii")).toMatchObject({ skipped: false });
    expect(byDataClass.get("moderation_logs")).toMatchObject({ skipped: false });
    expect(byDataClass.get("dsar_export_bundles")).toMatchObject({ skipped: false });

    expect(byDataClass.get("video_watch_events")).toMatchObject({ skipped: true });
    expect(byDataClass.get("video_watch_events")!.skipReason).toBeTruthy();
    expect(byDataClass.get("session_tokens")).toMatchObject({ skipped: true });
    expect(byDataClass.get("session_tokens")!.skipReason).toBeTruthy();
  });
});
