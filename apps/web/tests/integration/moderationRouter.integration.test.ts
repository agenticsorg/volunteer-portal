import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { moderationRouter } from "@/server/api/routers/moderation";
import { createCallerFactory } from "@/server/api/trpc";
import { createPost } from "@/modules/community";
import { createPerson, createChapterDirect, grantRoleDirect, contextFor } from "./helpers/identityFixtures";

// Exercises the moderation tRPC router (docs/ddd/moderation-trust-safety.md's
// API Contract Sketch) end to end against a real Postgres, via a direct
// (non-HTTP) caller — same shape as communityRouter/trainingRouter's own
// router integration suites. This file's job is the router-level adapter
// concerns: input validation (the closed reportedEntityType/reason/
// actionType sets, the scope-pair refinement), caller/person resolution,
// domain-error -> TRPCError code mapping, and the one `can()` check this
// router performs directly (`queryModerationHistory`) — the application
// layer's own scope-authority/ownership `can()` checks (ClaimReport,
// TakeModerationAction, RevokeModerationAction, ...) are exercised here only
// as much as proving the router wires the caller through correctly; their
// own exhaustive invariant coverage belongs to a moderation application-layer
// suite, not this router-level one.
describe("moderationRouter (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(moderationRouter);
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
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
  });

  afterAll(async () => {
    // Scoped to this file's own personIds — never an unscoped
    // deleteMany({}), which would race with other integration test files'
    // still-running tests against the same shared testcontainer Postgres
    // (Vitest runs integration test files in parallel by default) and
    // wipe their in-progress rows out from under them. Every Report/
    // ModerationAction/Post this file's procedures create carries a
    // reporter/target/author person id, so this file's own personIds are
    // enough to find every row's id without a separate tracked-id array.
    const [reportIds, moderationActionIds, postIds] = await Promise.all([
      prisma.report.findMany({ where: { reporterPersonId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.moderationAction.findMany({ where: { targetPersonId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.post.findMany({ where: { authorId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
    ]);

    await prisma.moderationDomainEvent.deleteMany({ where: { aggregateId: { in: [...reportIds, ...moderationActionIds] } } });
    await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.moderationAction.deleteMany({ where: { id: { in: moderationActionIds } } });
    await prisma.communityDomainEvent.deleteMany({ where: { aggregateId: { in: postIds } } });
    await prisma.feedEntry.deleteMany({ where: { subjectPersonId: { in: personIds } } });
    await prisma.post.deleteMany({ where: { id: { in: postIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.$disconnect();
  });

  async function person(overrides: Partial<{ displayName: string; primaryChapterId: string | null }> = {}) {
    const p = await createPerson(prisma, { displayName: overrides.displayName ?? "Moderation Router Test Person" });
    track(p.id);
    return { ...p, primaryChapterId: overrides.primaryChapterId ?? null };
  }

  async function orgAdmin() {
    const p = await person({ displayName: "Moderation Router Org Admin" });
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function chapterModerator(chapterId: string) {
    const p = await person({ displayName: "Moderation Router Chapter Moderator", primaryChapterId: chapterId });
    await grantRoleDirect(prisma, { subjectId: p.id, role: "moderator", scopeType: "chapter", scopeId: chapterId, grantedBy: p.id });
    return p;
  }

  async function chapter(name: string) {
    const c = await createChapterDirect(prisma, { name });
    chapterIds.push(c.id);
    return c;
  }

  function callerFor(p: {
    id: string;
    publicSlug: string;
    displayName: string;
    avatarUrl: string | null;
    status: string;
    primaryChapterId?: string | null;
  }) {
    return createCaller(contextFor(prisma, p));
  }

  describe("fileReport", () => {
    it("captures a Post's snapshot and files an open report", async () => {
      const chapterA = await chapter("Moderation Router Chapter A");
      const author = await person({ primaryChapterId: chapterA.id });
      const reporter = await person();

      const post = await createPost(prisma, {
        caller: { id: author.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "Content someone will report.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });

      const filed = await callerFor(reporter).fileReport({
        reportedEntityType: "community.post",
        reportedEntityId: post.postId,
        reason: "harassment",
      });
      expect(filed.reportId).toBeTruthy();
    });

    it("rejects a self-report against identity.person as BAD_REQUEST", async () => {
      const p = await person();
      await expect(
        callerFor(p).fileReport({ reportedEntityType: "identity.person", reportedEntityId: p.id, reason: "other" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("surfaces an unsupported reportedEntityType as NOT_IMPLEMENTED", async () => {
      const reporter = await person();
      const target = await person();
      await expect(
        callerFor(reporter).fileReport({
          reportedEntityType: "community.kudos",
          reportedEntityId: target.id,
          reason: "spam",
        }),
      ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    });
  });

  describe("report review lifecycle", () => {
    it("a chapter moderator outside the report's chapter cannot claim it (FORBIDDEN)", async () => {
      const chapterA = await chapter("Moderation Router Chapter B");
      const chapterB = await chapter("Moderation Router Chapter C");
      const author = await person({ primaryChapterId: chapterA.id });
      const reporter = await person();
      const outsideModerator = await chapterModerator(chapterB.id);

      const post = await createPost(prisma, {
        caller: { id: author.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "Another reportable post.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      const filed = await callerFor(reporter).fileReport({
        reportedEntityType: "community.post",
        reportedEntityId: post.postId,
        reason: "spam",
      });

      await expect(callerFor(outsideModerator).claimReport({ reportId: filed.reportId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("claim -> resolve by the same chapter moderator succeeds end to end", async () => {
      const chapterA = await chapter("Moderation Router Chapter D");
      const author = await person({ primaryChapterId: chapterA.id });
      const reporter = await person();
      const moderator = await chapterModerator(chapterA.id);

      const post = await createPost(prisma, {
        caller: { id: author.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "A post claimed and resolved.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      const filed = await callerFor(reporter).fileReport({
        reportedEntityType: "community.post",
        reportedEntityId: post.postId,
        reason: "misinformation",
      });

      const claimed = await callerFor(moderator).claimReport({ reportId: filed.reportId });
      expect(claimed.status).toBe("reviewing");

      const resolved = await callerFor(moderator).resolveReport({
        reportId: filed.reportId,
        resolutionNotes: "Reviewed, no action needed beyond a note.",
      });
      expect(resolved.status).toBe("resolved");
    });

    it("fast-dismiss from open requires mandatory resolutionNotes and moves the report to dismissed", async () => {
      const chapterA = await chapter("Moderation Router Chapter E");
      const author = await person({ primaryChapterId: chapterA.id });
      const reporter = await person();
      const moderator = await chapterModerator(chapterA.id);

      const post = await createPost(prisma, {
        caller: { id: author.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "A post fast-dismissed.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      const filed = await callerFor(reporter).fileReport({
        reportedEntityType: "community.post",
        reportedEntityId: post.postId,
        reason: "other",
      });

      const dismissed = await callerFor(moderator).dismissReport({
        reportId: filed.reportId,
        resolutionNotes: "Not a violation.",
      });
      expect(dismissed.status).toBe("dismissed");
    });
  });

  describe("enforcement ladder", () => {
    it("a chapter moderator cannot issue an org-scoped action (FORBIDDEN)", async () => {
      const chapterA = await chapter("Moderation Router Chapter F");
      const moderator = await chapterModerator(chapterA.id);
      const target = await person();

      await expect(
        callerFor(moderator).takeModerationAction({
          targetPersonId: target.id,
          actionType: "warn",
          reason: "Org-wide warning attempt.",
          scopeType: "org",
          scopeId: null,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a chapter-scoped ban as BAD_REQUEST — a ban is always org-scoped", async () => {
      const chapterA = await chapter("Moderation Router Chapter G");
      const admin = await orgAdmin();
      const target = await person({ primaryChapterId: chapterA.id });

      await expect(
        callerFor(admin).takeModerationAction({
          targetPersonId: target.id,
          actionType: "ban",
          reason: "Attempted chapter-scoped ban.",
          scopeType: "chapter",
          scopeId: chapterA.id,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("issues a chapter-scoped mute, it shows up in getMyActiveActions, and the issuing moderator can revoke it", async () => {
      const chapterA = await chapter("Moderation Router Chapter H");
      const moderator = await chapterModerator(chapterA.id);
      const target = await person({ primaryChapterId: chapterA.id });

      const taken = await callerFor(moderator).takeModerationAction({
        targetPersonId: target.id,
        actionType: "mute",
        reason: "Repeated off-topic posting.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        endsAt: null,
      });
      expect(taken.actionId).toBeTruthy();

      const active = await callerFor(target).getMyActiveActions();
      expect(active.some((a) => a.actionId === taken.actionId && a.actionType === "mute")).toBe(true);

      const revoked = await callerFor(moderator).revokeModerationAction({
        actionId: taken.actionId,
        revokeReason: "Volunteer apologized and corrected course.",
      });
      expect(revoked.status).toBe("revoked");
    });

    it("only the issuing moderator or an org_admin may revoke — a different moderator gets FORBIDDEN", async () => {
      const chapterA = await chapter("Moderation Router Chapter I");
      const moderator = await chapterModerator(chapterA.id);
      const otherModerator = await chapterModerator(chapterA.id);
      const target = await person({ primaryChapterId: chapterA.id });

      const taken = await callerFor(moderator).takeModerationAction({
        targetPersonId: target.id,
        actionType: "warn",
        reason: "First warning.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });

      await expect(
        callerFor(otherModerator).revokeModerationAction({ actionId: taken.actionId, revokeReason: "Not my call." }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("queryModerationHistory", () => {
    it("an org_admin may query unfiltered (org-wide) history", async () => {
      const admin = await orgAdmin();
      const page = await callerFor(admin).queryModerationHistory({});
      expect(Array.isArray(page.entries)).toBe(true);
    });

    it("a chapter moderator without a chapterId filter is FORBIDDEN from unfiltered history", async () => {
      const chapterA = await chapter("Moderation Router Chapter J");
      const moderator = await chapterModerator(chapterA.id);

      await expect(callerFor(moderator).queryModerationHistory({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a chapter moderator filtering by their own chapterId succeeds", async () => {
      const chapterA = await chapter("Moderation Router Chapter K");
      const moderator = await chapterModerator(chapterA.id);

      const page = await callerFor(moderator).queryModerationHistory({ chapterId: chapterA.id });
      expect(Array.isArray(page.entries)).toBe(true);
    });
  });

  describe("initiateEvidenceUpload — R2 not configured in this environment", () => {
    it("surfaces ExternalServiceNotConfiguredError as INTERNAL_SERVER_ERROR naming the missing env var", async () => {
      const p = await person();
      await expect(callerFor(p).initiateEvidenceUpload({ fileExtension: "png" })).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: expect.stringContaining("CLOUDFLARE_ACCOUNT_ID"),
      });
    });
  });
});
