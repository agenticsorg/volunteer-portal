import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { communityRouter } from "@/server/api/routers/community";
import { createCallerFactory } from "@/server/api/trpc";
import { takeModerationAction } from "@/modules/moderation";
import { createPerson, createChapterDirect, grantRoleDirect, contextFor } from "./helpers/identityFixtures";

// Exercises the community tRPC router (docs/ddd/community-social.md's API
// Contract Sketch) end to end against a real Postgres, via a direct
// (non-HTTP) caller — same shape as gamificationRouter/trainingRouter's own
// router integration suites. `community.integration.test.ts` covers the
// application layer underneath in depth (including this phase's own
// completion bar); this file's job is the router-level adapter concerns:
// input validation (the scope-pair refinement), the caller/person
// resolution `createPost`'s `authorChapterId` depends on, and domain-error
// -> TRPCError code mapping.
describe("communityRouter (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(communityRouter);
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
    // wipe their in-progress rows out from under them. The aggregate
    // tables below (post/kudos/team/teamMembership/mentorship/
    // moderationAction) don't need their own tracked-id arrays — every row
    // any of this file's procedures create is reachable by querying for
    // this file's own personIds first, since every one of those aggregates
    // carries an author/actor/target person id.
    const [postIds, kudosIds, teamIds, teamMembershipIds, mentorshipIds, moderationActionIds] = await Promise.all([
      prisma.post.findMany({ where: { authorId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.kudos
        .findMany({ where: { OR: [{ fromPersonId: { in: personIds } }, { toPersonId: { in: personIds } }] }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id)),
      prisma.team.findMany({ where: { createdByPersonId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.teamMembership.findMany({ where: { personId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      prisma.mentorship
        .findMany({ where: { OR: [{ mentorPersonId: { in: personIds } }, { menteePersonId: { in: personIds } }] }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id)),
      prisma.moderationAction.findMany({ where: { targetPersonId: { in: personIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)),
    ]);

    await prisma.communityDomainEvent.deleteMany({
      where: { aggregateId: { in: [...postIds, ...kudosIds, ...teamIds, ...teamMembershipIds, ...mentorshipIds] } },
    });
    // communityProcessedEvent is never written by this file (no test here
    // calls consumeInboundEvent) — nothing of this file's ever lands there,
    // so there is nothing to scope/delete.
    await prisma.feedEntry.deleteMany({ where: { subjectPersonId: { in: personIds } } });
    await prisma.kudos.deleteMany({ where: { id: { in: kudosIds } } });
    await prisma.teamMembership.deleteMany({ where: { id: { in: teamMembershipIds } } });
    await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
    await prisma.mentorship.deleteMany({ where: { id: { in: mentorshipIds } } });
    await prisma.post.deleteMany({ where: { id: { in: postIds } } });
    await prisma.moderationDomainEvent.deleteMany({ where: { aggregateId: { in: moderationActionIds } } });
    await prisma.moderationAction.deleteMany({ where: { targetPersonId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.$disconnect();
  });

  async function person(overrides: Partial<{ displayName: string; primaryChapterId: string | null }> = {}) {
    const p = await createPerson(prisma, { displayName: overrides.displayName ?? "Community Router Test Person" });
    track(p.id);
    return { ...p, primaryChapterId: overrides.primaryChapterId ?? null };
  }

  async function orgAdmin() {
    const p = await person({ displayName: "Community Router Org Admin" });
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
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

  describe("createPost / getFeed — end to end through the real procedures", () => {
    it("creates a chapter-scoped post and it appears via getFeed({scopeType: 'chapter'})", async () => {
      const chapterA = await chapter("Router Chapter A");
      const author = await person({ primaryChapterId: chapterA.id });

      const created = await callerFor(author).createPost({
        body: "Hello from the router-level test.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [],
      });
      expect(created.postId).toBeTruthy();

      const feed = await callerFor(author).getFeed({ scopeType: "chapter", scopeId: chapterA.id, limit: 10 });
      expect(feed.entries.some((e) => e.sourceId === created.postId)).toBe(true);
    });

    it("rejects an org-scoped createPost from a non-org_admin with FORBIDDEN", async () => {
      const author = await person();
      await expect(
        callerFor(author).createPost({ body: "Trying org scope.", scopeType: "org", scopeId: null, attachments: [] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("an org_admin can create an org-scoped post", async () => {
      const admin = await orgAdmin();
      const created = await callerFor(admin).createPost({
        body: "An org-wide announcement via the router.",
        scopeType: "org",
        scopeId: null,
        attachments: [],
      });
      expect(created.postId).toBeTruthy();

      const feed = await callerFor(admin).getFeed({ scopeType: "org", scopeId: null, limit: 10 });
      expect(feed.entries.some((e) => e.sourceId === created.postId)).toBe(true);
    });

    it("getFeed rejects a scope pair that violates the org/chapter refinement, before any resolver runs", async () => {
      const p = await person();
      const caller = callerFor(p);
      // Both calls are TS-valid (scopeId's type is `string | null` regardless
      // of scopeType) but violate `scopePairSchema`'s runtime `.refine()` —
      // rejected by zod before either getChapterFeed/getOrgFeed ever runs.
      await expect(caller.getFeed({ scopeType: "org", scopeId: newId(), limit: 10 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(caller.getFeed({ scopeType: "chapter", scopeId: null, limit: 10 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  describe("search — same scope-pair validation as getFeed", () => {
    it("rejects a malformed scope pair as BAD_REQUEST", async () => {
      const caller = callerFor(await person());
      // Same scope-pair refinement as getFeed's own test above — TS-valid, rejected at runtime by zod.
      await expect(caller.search({ scopeType: "chapter", scopeId: null, query: "test" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  describe("giveKudos", () => {
    it("rejects self-kudos as BAD_REQUEST and succeeds for a real recipient", async () => {
      const p = await person();
      await expect(callerFor(p).giveKudos({ toPersonId: p.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const recipient = await person();
      const given = await callerFor(p).giveKudos({ toPersonId: recipient.id, note: "Nicely done." });
      expect(given.kudosId).toBeTruthy();

      const received = await callerFor(recipient).getKudosReceived({ personId: recipient.id });
      expect(received.some((k) => k.kudosId === given.kudosId)).toBe(true);
    });
  });

  describe("Phase 7 enforcement — an active Moderation suspend/ban maps to FORBIDDEN through this router", () => {
    it("createPost and giveKudos both reject with FORBIDDEN once moderation.takeModerationAction issues an org-wide suspend", async () => {
      const chapterA = await chapter("Router Enforcement Chapter");
      const admin = await orgAdmin();
      const suspended = await person({ primaryChapterId: chapterA.id });
      const recipient = await person();

      await takeModerationAction(prisma, {
        caller: { id: admin.id, status: "active" },
        targetPersonId: suspended.id,
        actionType: "suspend",
        reason: "Router-level enforcement regression test.",
        scopeType: "org",
        scopeId: null,
        endsAt: null,
      });

      await expect(
        callerFor(suspended).createPost({
          body: "Should be blocked by the active suspend.",
          scopeType: "chapter",
          scopeId: chapterA.id,
          attachments: [],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await expect(callerFor(suspended).giveKudos({ toPersonId: recipient.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("Teams and Mentorship — end to end through the real procedures", () => {
    it("createTeam then joinTeam succeeds, and a duplicate team name is CONFLICT", async () => {
      const chapterA = await chapter("Router Team Chapter");
      const founder = await person({ primaryChapterId: chapterA.id });
      const joiner = await person({ primaryChapterId: chapterA.id });

      const team = await callerFor(founder).createTeam({ chapterId: chapterA.id, name: "Router Guild" });
      expect(team.teamId).toBeTruthy();

      const joined = await callerFor(joiner).joinTeam({ teamId: team.teamId });
      expect(joined.teamMembershipId).toBeTruthy();

      await expect(
        callerFor(founder).createTeam({ chapterId: chapterA.id, name: "Router Guild" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("requestMentorship then acceptMentorship succeeds; a non-mentor accepting is FORBIDDEN", async () => {
      const mentor = await person();
      const mentee = await person();
      const impostor = await person();

      const requested = await callerFor(mentee).requestMentorship({ mentorPersonId: mentor.id });
      expect(requested.mentorshipId).toBeTruthy();

      await expect(
        callerFor(impostor).acceptMentorship({ mentorshipId: requested.mentorshipId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const accepted = await callerFor(mentor).acceptMentorship({ mentorshipId: requested.mentorshipId });
      expect(accepted.status).toBe("active");
    });
  });

  describe("initiatePostAttachmentUpload — R2 not configured in this environment", () => {
    it("surfaces ExternalServiceNotConfiguredError as INTERNAL_SERVER_ERROR naming the missing env var", async () => {
      const p = await person();
      await expect(
        callerFor(p).initiatePostAttachmentUpload({ fileExtension: "jpg" }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: expect.stringContaining("CLOUDFLARE_ACCOUNT_ID") });
    });
  });
});
