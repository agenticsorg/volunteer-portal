import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { searchAuditLog, ForbiddenActionError } from "@/modules/admin";
import { fileReport } from "@/modules/moderation";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject } from "./helpers/volunteeringFixtures";

// Exercises `SearchAuditLog` (docs/ddd/admin-reporting.md, Key Use Case 6)
// against a real Postgres — Phase 9's "Do not consider this phase complete
// until" bar's third bullet: "SearchAuditLog with source: 'both' returns
// both a platform-wide summary entry AND, for a moderation action, the
// fuller moderation-owned detail, each tagged so a UI could tell them
// apart."
//
// CRITICAL invariant under test/verified here (restated from
// `searchAuditLog.ts`'s own header): the two read paths — a plain Prisma
// query against this schema's own `admin.audit_log`, and a call through
// `moderation`'s `index.ts` barrel into `moderation.queryModerationHistory`
// — run independently and are merged with a plain TypeScript array
// concat/sort AFTER both awaits resolve (`searchAuditLog.ts` lines ~118-185:
// `entries.push(...)` from two separate loops, one plain `Array#sort` at
// the end). There is no single SQL statement, view, or Prisma query in
// that file that references both `admin.*` and `moderation.*` tables — a
// hard architectural rule, not a style preference, confirmed by reading
// that implementation directly (this test file does not re-derive that
// guarantee at runtime — a plain application-code array merge has no
// distinguishing runtime signature to assert against; the source itself,
// plus this behavioral proof that BOTH independent sources really did
// each contribute their own row, is the verification).
describe("Admin audit search — SearchAuditLog, source: 'both' (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const reportIds: string[] = [];
  const moderationActionIds: string[] = [];
  const auditLogIds: string[] = [];

  afterAll(async () => {
    // `admin.audit_log` is insert-only (ADR-0014 §4 — enforced by a real DB
    // trigger, see `auditLogInsertOnly.integration.test.ts`): the rows this
    // suite inserts directly (standing in for what `audit_log_writer` would
    // have appended) are deliberately never deleted here, same precedent
    // `auditLogWriter.integration.test.ts`'s own afterAll already sets.
    await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.moderationAction.deleteMany({ where: { id: { in: moderationActionIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function orgAdmin(displayName: string) {
    const p = await createPerson(prisma, { displayName });
    personIds.push(p.id);
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function person(displayName: string) {
    const p = await createPerson(prisma, { displayName });
    personIds.push(p.id);
    return p;
  }

  /**
   * A real `Report` (via `fileReport`) resolved by a real `ModerationAction`
   * — `resolveReport`'s own claim state machine is wired directly here
   * (`report.update`), not through `claimReport`/`resolveReport`, since
   * this suite's unit under test is `SearchAuditLog`'s own read/merge
   * behavior, not moderation's `open -> reviewing -> resolved` transition
   * rules (already covered by `moderationTrustSafety.integration.test.ts`)
   * — same "insert directly via Prisma, don't depend on an unrelated
   * use case's own preconditions" precedent every other fixture helper in
   * this test suite already follows.
   */
  async function fileAndResolveReportAgainst(reporter: { id: string; status: string }, moderator: { id: string }, target: { id: string }) {
    const filed = await fileReport(prisma, {
      caller: callerSubject(reporter),
      reportedEntityType: "identity.person",
      reportedEntityId: target.id,
      reason: "harassment",
    });
    reportIds.push(filed.reportId);

    const actionId = newId();
    await prisma.moderationAction.create({
      data: {
        id: actionId,
        actionType: "warn",
        targetPersonId: target.id,
        moderatorPersonId: moderator.id,
        reason: "Test warn — adminAuditSearch fixture.",
        relatedReportId: filed.reportId,
        scopeType: "org",
        scopeId: null,
      },
    });
    moderationActionIds.push(actionId);

    await prisma.report.update({
      where: { id: filed.reportId },
      data: {
        status: "resolved",
        assignedModeratorId: moderator.id,
        resolutionActionId: actionId,
        resolutionNotes: "Resolved for adminAuditSearch fixture.",
        resolvedAt: new Date(),
      },
    });

    return { reportId: filed.reportId, actionId };
  }

  it("with source: 'both', returns BOTH a platform-wide admin.audit_log summary AND the fuller moderation-owned detail for the same moderation action, each tagged so a UI can tell them apart", async () => {
    const org = await orgAdmin("Audit Search Admin");
    const reporter = await person("Audit Search Reporter");
    const target = await person("Audit Search Target");

    const { reportId, actionId } = await fileAndResolveReportAgainst(reporter, org, target);

    // A summarized `admin.audit_log` entry, exactly the shape the real
    // `audit_log_writer` outbox-drain consumer would have appended for
    // this moderation action (ADR-0014 §4) — inserted directly here so
    // this suite doesn't also need to spawn the real worker process
    // (`auditLogWriter.integration.test.ts` already proves that drain
    // path works end to end); `SearchAuditLog` itself only ever reads
    // `admin.audit_log`, never cares how a row got there.
    const auditLogId = newId();
    await prisma.auditLog.create({
      data: {
        id: auditLogId,
        actorId: org.id,
        actorType: "user",
        action: "moderation.warn",
        resourceType: "person",
        resourceId: target.id,
        scopeType: "global",
        metadata: { actionId, reportId },
      },
    });
    auditLogIds.push(auditLogId);

    const result = await searchAuditLog(prisma, {
      caller: callerSubject(org),
      filters: { resourceType: "person", resourceId: target.id },
      source: "both",
    });

    const platformEntries = result.entries.filter((e) => e.source === "platform_summary");
    const moderationEntries = result.entries.filter((e) => e.source === "moderation_detail");

    expect(platformEntries).toHaveLength(1);
    expect(platformEntries[0]).toMatchObject({
      source: "platform_summary",
      id: auditLogId,
      action: "moderation.warn",
      resourceType: "person",
      resourceId: target.id,
    });

    expect(moderationEntries).toHaveLength(1);
    const moderationEntry = moderationEntries[0]!;
    expect(moderationEntry).toMatchObject({
      source: "moderation_detail",
      id: reportId,
      action: "moderation.warn",
      resourceType: "report",
    });
    if (moderationEntry.source === "moderation_detail") {
      // The fuller, evidence-linked detail `moderation.queryModerationHistory`
      // itself carries — not obtainable from the platform_summary row above.
      expect(moderationEntry.detail.resolutionAction).toMatchObject({
        actionId,
        actionType: "warn",
        targetPersonId: target.id,
        moderatorPersonId: org.id,
      });
      expect(moderationEntry.detail.reportedEntityType).toBe("identity.person");
    }
  });

  it("with source: 'platform', returns only the platform-wide summary — no moderation detail", async () => {
    const org = await orgAdmin("Platform-Only Admin");
    const reporter = await person("Platform-Only Reporter");
    const target = await person("Platform-Only Target");
    const { reportId, actionId } = await fileAndResolveReportAgainst(reporter, org, target);

    const auditLogId = newId();
    await prisma.auditLog.create({
      data: {
        id: auditLogId,
        actorId: org.id,
        actorType: "user",
        action: "moderation.warn",
        resourceType: "person",
        resourceId: target.id,
        scopeType: "global",
        metadata: { actionId, reportId },
      },
    });
    auditLogIds.push(auditLogId);

    const result = await searchAuditLog(prisma, {
      caller: callerSubject(org),
      filters: { resourceType: "person", resourceId: target.id },
      source: "platform",
    });

    expect(result.entries.every((e) => e.source === "platform_summary")).toBe(true);
    expect(result.entries.map((e) => e.id)).toContain(auditLogId);
  });

  it("with source: 'moderation_history', returns only the moderation-owned detail — no platform summary", async () => {
    const org = await orgAdmin("Moderation-Only Admin");
    const reporter = await person("Moderation-Only Reporter");
    const target = await person("Moderation-Only Target");
    const { reportId } = await fileAndResolveReportAgainst(reporter, org, target);

    const result = await searchAuditLog(prisma, {
      caller: callerSubject(org),
      filters: { resourceType: "person", resourceId: target.id },
      source: "moderation_history",
    });

    expect(result.entries.every((e) => e.source === "moderation_detail")).toBe(true);
    expect(result.entries.map((e) => e.id)).toContain(reportId);
  });

  it("rejects SearchAuditLog from a caller who is not an org_admin", async () => {
    const nonAdmin = await person("Not An Admin");
    await expect(
      searchAuditLog(prisma, { caller: callerSubject(nonAdmin), filters: {}, source: "both" }),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });
});
