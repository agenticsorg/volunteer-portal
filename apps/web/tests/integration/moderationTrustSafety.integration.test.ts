import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  fileReport,
  takeModerationAction,
  getActiveActionsForPerson,
  OutOfScopeError,
} from "@/modules/moderation";
import { createPost, getPostSnapshot, giveKudos, ActiveModerationSanctionError } from "@/modules/community";
import { createPerson, createChapterDirect, grantRoleDirect } from "./helpers/identityFixtures";

// Exercises Phase 7's own completion bar verbatim
// (docs/plans/implementation-plan.md, "Do not consider this phase
// complete until"):
//   - filing a report against a Post captures an immutable content
//     snapshot that does not change even after the Post is later edited.
//   - a chapter-scoped moderator is blocked from issuing an org-scoped
//     action (negative test), AND a ban is always recorded as org-scoped
//     regardless of report origin.
//   - an active suspend or ban actually blocks CreatePost and GiveKudos in
//     Community — proof the Phase 6 callback (`community.createPost`/
//     `community.giveKudos` calling `moderation.getActiveActionsForPerson`)
//     was actually wired correctly, not just that Moderation works in
//     isolation.
//   - no `moderation.audit_log` table exists anywhere in the schema (see
//     also `auditLogWriter.integration.test.ts` for the companion "a real
//     moderation action's audit event actually drains into
//     `admin.audit_log`" proof).
describe("Moderation & Trust/Safety — Phase 7 completion bar (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    // Scoped to this file's own personIds — never an unscoped
    // deleteMany({}), which would race with other integration test files'
    // still-running tests against the same shared testcontainer Postgres
    // (Vitest runs integration test files in parallel by default) and
    // wipe their in-progress rows out from under them. Every Report/
    // ModerationAction/Post/Kudos this file's calls create carries a
    // reporter/target/author/giver-or-recipient person id, so this file's
    // own personIds are enough to find every row's id without a separate
    // tracked-id array.
    const [reportIds, moderationActionIds, postIds, kudosIds] = await Promise.all([
      prisma.report.findMany({ where: { reporterPersonId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.moderationAction.findMany({ where: { targetPersonId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.post.findMany({ where: { authorId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.kudos
        .findMany({ where: { OR: [{ fromPersonId: { in: personIds } }, { toPersonId: { in: personIds } }] }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id)),
    ]);

    await prisma.moderationDomainEvent.deleteMany({ where: { aggregateId: { in: [...reportIds, ...moderationActionIds] } } });
    await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.moderationAction.deleteMany({ where: { id: { in: moderationActionIds } } });
    await prisma.communityDomainEvent.deleteMany({ where: { aggregateId: { in: [...postIds, ...kudosIds] } } });
    await prisma.feedEntry.deleteMany({ where: { subjectPersonId: { in: personIds } } });
    await prisma.post.deleteMany({ where: { id: { in: postIds } } });
    await prisma.kudos.deleteMany({ where: { id: { in: kudosIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.$disconnect();
  });

  async function person(overrides: Partial<{ displayName: string; primaryChapterId: string | null }> = {}) {
    const p = await createPerson(prisma, { displayName: overrides.displayName ?? "Moderation Trust/Safety Test Person" });
    track(p.id);
    return { ...p, primaryChapterId: overrides.primaryChapterId ?? null };
  }

  async function orgAdmin() {
    const p = await person({ displayName: "Moderation Trust/Safety Org Admin" });
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function chapterModerator(chapterId: string) {
    const p = await person({ displayName: "Moderation Trust/Safety Chapter Moderator", primaryChapterId: chapterId });
    await grantRoleDirect(prisma, {
      subjectId: p.id,
      role: "moderator",
      scopeType: "chapter",
      scopeId: chapterId,
      grantedBy: p.id,
    });
    return p;
  }

  async function chapter(name: string) {
    const c = await createChapterDirect(prisma, { name });
    chapterIds.push(c.id);
    return c;
  }

  describe("immutable content snapshot", () => {
    it("a Report's reportedContentSnapshot does not change after the reported Post is later edited", async () => {
      const chapterA = await chapter("Snapshot Chapter A");
      const author = await person({ primaryChapterId: chapterA.id });
      const reporter = await person();

      const post = await createPost(prisma, {
        caller: { id: author.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "The original content, before any edit.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });

      const filed = await fileReport(prisma, {
        caller: { id: reporter.id, status: "active" },
        reportedEntityType: "community.post",
        reportedEntityId: post.postId,
        reason: "harassment",
      });

      const reportBeforeEdit = await prisma.report.findUniqueOrThrow({ where: { id: filed.reportId } });
      const snapshotBeforeEdit = reportBeforeEdit.reportedContentSnapshot as { body: string };
      expect(snapshotBeforeEdit.body).toBe("The original content, before any edit.");

      // Simulate the Post being edited after the Report was filed — no
      // `editPost` use case exists yet in `community`, so this reaches
      // directly into the row, the same as a future edit mutation would.
      // `getPostSnapshot` itself is a live read (Phase 6's own Open Host
      // Service query) — the point under test is that `FileReport`
      // captured a COPY at file-time, never re-read afterward.
      await prisma.post.update({ where: { id: post.postId }, data: { body: "Edited after the report was filed." } });

      const liveSnapshot = await getPostSnapshot(prisma, post.postId);
      expect(liveSnapshot?.body).toBe("Edited after the report was filed.");

      const reportAfterEdit = await prisma.report.findUniqueOrThrow({ where: { id: filed.reportId } });
      const snapshotAfterEdit = reportAfterEdit.reportedContentSnapshot as { body: string };
      expect(snapshotAfterEdit.body).toBe("The original content, before any edit.");
      expect(snapshotAfterEdit.body).not.toBe(liveSnapshot?.body);
    });
  });

  describe("enforcement-ladder scope rules", () => {
    it("a chapter-scoped moderator is blocked (OutOfScopeError) from issuing an org-scoped action", async () => {
      const chapterA = await chapter("Scope Rules Chapter A");
      const moderator = await chapterModerator(chapterA.id);
      const target = await person();

      await expect(
        takeModerationAction(prisma, {
          caller: { id: moderator.id, status: "active" },
          targetPersonId: target.id,
          actionType: "warn",
          reason: "Attempting an org-wide warn from chapter authority.",
          scopeType: "org",
          scopeId: null,
        }),
      ).rejects.toBeInstanceOf(OutOfScopeError);
    });

    it("a ban is always recorded as org-scoped, even when it resolves a chapter-scoped report", async () => {
      const chapterA = await chapter("Scope Rules Chapter B");
      const admin = await orgAdmin();
      const author = await person({ primaryChapterId: chapterA.id });
      const reporter = await person();
      const target = await person({ primaryChapterId: chapterA.id });

      // The report itself originates chapter-scoped (the reported Post is
      // chapter-scoped) — proving the resulting ban's own scope is NOT
      // inherited from the report it resolves.
      const post = await createPost(prisma, {
        caller: { id: target.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "Content that will get its author banned.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      const filed = await fileReport(prisma, {
        caller: { id: reporter.id, status: "active" },
        reportedEntityType: "community.post",
        reportedEntityId: post.postId,
        reason: "safety_concern",
      });
      expect(filed).toBeTruthy();
      void author;

      const taken = await takeModerationAction(prisma, {
        caller: { id: admin.id, status: "active" },
        targetPersonId: target.id,
        actionType: "ban",
        reason: "Severe safety violation.",
        scopeType: "org",
        scopeId: null,
        relatedReportId: filed.reportId,
      });

      const actionRow = await prisma.moderationAction.findUniqueOrThrow({ where: { id: taken.actionId } });
      expect(actionRow.scopeType).toBe("org");
      expect(actionRow.scopeId).toBeNull();
      expect(actionRow.relatedReportId).toBe(filed.reportId);
    });
  });

  describe("Community enforcement regression — active sanctions actually block CreatePost/GiveKudos", () => {
    it("an org-scoped suspend blocks CreatePost (both org- and chapter-scoped writes) and GiveKudos", async () => {
      const chapterA = await chapter("Enforcement Chapter A");
      const admin = await orgAdmin();
      const target = await person({ primaryChapterId: chapterA.id });
      const kudosRecipient = await person();

      await takeModerationAction(prisma, {
        caller: { id: admin.id, status: "active" },
        targetPersonId: target.id,
        actionType: "suspend",
        reason: "Org-wide suspend for the enforcement regression test.",
        scopeType: "org",
        scopeId: null,
        endsAt: null,
      });

      await expect(
        createPost(prisma, {
          caller: { id: target.id, status: "active" },
          authorChapterId: chapterA.id,
          body: "This must be blocked by the active org-wide suspend.",
          scopeType: "chapter",
          scopeId: chapterA.id,
          attachments: [],
        }),
      ).rejects.toBeInstanceOf(ActiveModerationSanctionError);

      await expect(
        giveKudos(prisma, { caller: { id: target.id, status: "active" }, toPersonId: kudosRecipient.id }),
      ).rejects.toBeInstanceOf(ActiveModerationSanctionError);
    });

    it("a chapter-scoped suspend blocks a post into that same chapter, but not an org-scoped post or GiveKudos", async () => {
      const chapterA = await chapter("Enforcement Chapter B");
      const moderator = await chapterModerator(chapterA.id);
      const target = await person({ primaryChapterId: chapterA.id });
      const admin = await orgAdmin(); // needed for the org-scoped post branch
      const kudosRecipient = await person();

      await takeModerationAction(prisma, {
        caller: { id: moderator.id, status: "active" },
        targetPersonId: target.id,
        actionType: "suspend",
        reason: "Chapter-scoped suspend — confined to this chapter's own spaces.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        endsAt: null,
      });

      await expect(
        createPost(prisma, {
          caller: { id: target.id, status: "active" },
          authorChapterId: chapterA.id,
          body: "Blocked — this chapter is under an active chapter-scoped suspend.",
          scopeType: "chapter",
          scopeId: chapterA.id,
          attachments: [],
        }),
      ).rejects.toBeInstanceOf(ActiveModerationSanctionError);

      // A chapter sanction never restricts an org-wide write (ModerationAction
      // invariant 5 / getActiveActionsForPerson's own doc comment) — grant
      // target org_admin authority just for this one org-scoped post write.
      await grantRoleDirect(prisma, { subjectId: target.id, role: "org_admin", grantedBy: admin.id });
      const orgPost = await createPost(prisma, {
        caller: { id: target.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "Not blocked — org-scoped writes are outside this chapter sanction's reach.",
        scopeType: "org",
        scopeId: null,
        attachments: [],
      });
      expect(orgPost.postId).toBeTruthy();

      // GiveKudos carries no chapter dimension of its own — only an
      // org-wide sanction applies to it, so this chapter-scoped suspend
      // does not block it.
      const kudos = await giveKudos(prisma, { caller: { id: target.id, status: "active" }, toPersonId: kudosRecipient.id });
      expect(kudos.kudosId).toBeTruthy();
    });

    it("a mute does not block CreatePost or GiveKudos — only suspend/ban are blocking", async () => {
      const chapterA = await chapter("Enforcement Chapter C");
      const admin = await orgAdmin();
      const target = await person({ primaryChapterId: chapterA.id });
      const kudosRecipient = await person();

      await takeModerationAction(prisma, {
        caller: { id: admin.id, status: "active" },
        targetPersonId: target.id,
        actionType: "mute",
        reason: "A mute, deliberately not org-wide-blocking.",
        scopeType: "org",
        scopeId: null,
        endsAt: null,
      });

      const post = await createPost(prisma, {
        caller: { id: target.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "A mute alone must not block this write.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      expect(post.postId).toBeTruthy();

      const kudos = await giveKudos(prisma, { caller: { id: target.id, status: "active" }, toPersonId: kudosRecipient.id });
      expect(kudos.kudosId).toBeTruthy();
    });

    it("CreatePost succeeds again once the blocking suspend is revoked", async () => {
      const chapterA = await chapter("Enforcement Chapter D");
      const admin = await orgAdmin();
      const target = await person({ primaryChapterId: chapterA.id });

      const taken = await takeModerationAction(prisma, {
        caller: { id: admin.id, status: "active" },
        targetPersonId: target.id,
        actionType: "suspend",
        reason: "Temporary — will be revoked mid-test.",
        scopeType: "org",
        scopeId: null,
        endsAt: null,
      });

      await expect(
        createPost(prisma, {
          caller: { id: target.id, status: "active" },
          authorChapterId: chapterA.id,
          body: "Blocked while the suspend is active.",
          scopeType: "chapter",
          scopeId: chapterA.id,
          attachments: [],
        }),
      ).rejects.toBeInstanceOf(ActiveModerationSanctionError);

      await prisma.moderationAction.update({
        where: { id: taken.actionId },
        data: { status: "revoked", revokedByPersonId: admin.id, revokedAt: new Date(), revokeReason: "Test cleanup." },
      });

      const afterRevoke = await getActiveActionsForPerson(prisma, target.id, { scopeType: "org", scopeId: null });
      expect(afterRevoke).toHaveLength(0);

      const post = await createPost(prisma, {
        caller: { id: target.id, status: "active" },
        authorChapterId: chapterA.id,
        body: "Allowed again now that the suspend is revoked.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      expect(post.postId).toBeTruthy();
    });
  });

  describe("no moderation.audit_log table exists", () => {
    it("information_schema confirms the moderation schema has no audit_log table (or any table matching '%audit%')", async () => {
      const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'moderation' AND table_name ILIKE '%audit%'
      `;
      expect(rows).toHaveLength(0);
    });

    it("the moderation schema's only tables are report, moderation_action, and domain_events", async () => {
      const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'moderation' AND table_type = 'BASE TABLE'
         ORDER BY table_name
      `;
      expect(rows.map((r) => r.table_name).sort()).toEqual(["domain_events", "moderation_action", "report"]);
    });
  });
});
