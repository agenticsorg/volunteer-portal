import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { gamificationRouter } from "@/server/api/routers/gamification";
import { createCallerFactory } from "@/server/api/trpc";
import { consumeInboundEvent, rebuildLeaderboardSnapshot, type InboundEvent } from "@/modules/gamification";
import { createPerson, grantRoleDirect, contextFor } from "./helpers/identityFixtures";

// Exercises the gamification tRPC router (docs/ddd/gamification.md's API
// Contract Sketch) end to end against a real Postgres, via a direct
// (non-HTTP) caller — same shape as identityRouter/volunteeringRouter/
// trainingRouter's own router integration suites.
//
// This is the literal "assert this at the API layer itself" half of the
// Phase 5 completion bar (docs/plans/implementation-plan.md): "no
// leaderboard API path can return an unscoped, platform-wide ranking" is
// proven here by driving the real `gamificationRouter.getLeaderboard`
// *procedure* — not just the `getLeaderboard` application function
// underneath it (see gamification.integration.test.ts for that
// lower-level coverage) — with a request that omits scope / attempts
// `scopeType: 'global'`, and confirming zod rejects it before the resolver
// (and therefore any database read) ever runs.
describe("gamificationRouter (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(gamificationRouter);
  const personIds: string[] = [];
  const badgeIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    // Scoped to this file's own personIds — never an unscoped
    // deleteMany({}), which would race with other integration test files'
    // still-running tests against the same shared testcontainer Postgres
    // (Vitest runs integration test files in parallel by default) and
    // wipe their in-progress rows out from under them. Every
    // PointsLedgerEntry/BadgeAward/Streak this file's calls create carries
    // this file's own tracked personId, so those (already-scoped) tables
    // are queried first to find the aggregate/source-event ids that
    // `gamificationDomainEvent`/`gamificationProcessedEvent` need to be
    // scoped by in turn — see gamification.integration.test.ts's own
    // afterAll comment for why `pointsLedgerEntry.sourceEventId` reliably
    // covers every `gamificationProcessedEvent` row this file wrote too
    // (also covers this file's own adminAdjustPoints/adminAwardBadge
    // writes, which likewise always insert a PointsLedgerEntry/BadgeAward
    // row keyed to a tracked personId).
    const [ledgerEntries, badgeAwards, streaks] = await Promise.all([
      prisma.pointsLedgerEntry.findMany({ where: { personId: { in: personIds } }, select: { id: true, sourceEventId: true } }),
      prisma.badgeAward.findMany({ where: { personId: { in: personIds } }, select: { id: true } }),
      prisma.streak.findMany({ where: { personId: { in: personIds } }, select: { id: true } }),
    ]);
    const aggregateIds = [...ledgerEntries.map((e) => e.id), ...badgeAwards.map((a) => a.id), ...streaks.map((s) => s.id)];
    const sourceEventIds = ledgerEntries.map((e) => e.sourceEventId);

    await prisma.gamificationDomainEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
    await prisma.gamificationProcessedEvent.deleteMany({ where: { sourceEventId: { in: sourceEventIds } } });
    await prisma.leaderboardSnapshot.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.badgeAward.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.badge.deleteMany({ where: { id: { in: badgeIds } } });
    await prisma.streak.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.pointsLedgerEntry.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.pointsBalance.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function person() {
    const p = await createPerson(prisma, { displayName: "Gamification Router Test Person" });
    track(p.id);
    return p;
  }

  async function orgAdmin() {
    const p = await person();
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  function callerFor(p: { id: string; publicSlug: string; displayName: string; avatarUrl: string | null; status: string }) {
    return createCaller(contextFor(prisma, p));
  }

  function hoursApprovedEvent(personId: string, durationMinutes = 60): InboundEvent {
    return {
      sourceEventId: newId(),
      eventType: "HoursApproved",
      payload: {
        hourEntryId: newId(),
        personId,
        opportunityId: newId(),
        shiftId: newId(),
        chapterId: null,
        durationMinutes,
        approverPersonId: newId(),
        approvedAt: new Date().toISOString(),
      },
    };
  }

  describe("getLeaderboard: never an unscoped/global ranking (Phase 5 completion bar)", () => {
    it("rejects a request that omits scopeType/scopeId entirely, before any resolver/database access", async () => {
      const caller = callerFor(await person());
      // @ts-expect-error — deliberately omitting the required scope input,
      // the same way a malformed client request body would.
      await expect(caller.getLeaderboard({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects scopeType: 'global' — not a representable value in the input schema", async () => {
      const caller = callerFor(await person());
      await expect(
        // @ts-expect-error — 'global' bypasses the `'team' | 'challenge'` union.
        caller.getLeaderboard({ scopeType: "global", scopeId: newId() }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects an arbitrary unrecognized scopeType the same way", async () => {
      const caller = callerFor(await person());
      await expect(
        // @ts-expect-error — same as above.
        caller.getLeaderboard({ scopeType: "platform", scopeId: newId() }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("a valid 'team' scope succeeds end to end through the real procedure", async () => {
      const alice = await person();
      await consumeInboundEvent(prisma, hoursApprovedEvent(alice.id, 60)); // 10 pts

      const teamId = newId();
      const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await rebuildLeaderboardSnapshot(prisma, {
        scope: { scopeType: "team", scopeId: teamId },
        memberPersonIds: [alice.id],
        periodStart,
        periodEnd,
      });

      const caller = callerFor(alice);
      const board = await caller.getLeaderboard({
        scopeType: "team",
        scopeId: teamId,
        periodStart: periodStart.toISOString(),
      });
      expect(board.entries).toEqual([{ personId: alice.id, rank: 1, points: 10 }]);
    });
  });

  describe("getMyPointsBalance / getPersonGamificationProfile / listBadges", () => {
    it("getMyPointsBalance reflects a person's own ledger via the router", async () => {
      const p = await person();
      await consumeInboundEvent(prisma, hoursApprovedEvent(p.id, 120)); // 20 pts

      const balance = await callerFor(p).getMyPointsBalance();
      expect(balance.totalPoints).toBe(BigInt(20));
    });

    it("a badge remains on getPersonGamificationProfile's response after its definition is deactivated (public procedure)", async () => {
      const p = await person();
      const courseId = newId();
      const badgeId = newId();
      badgeIds.push(badgeId);
      await prisma.badge.create({
        data: {
          id: badgeId,
          slug: `router-course-graduate-${badgeId.toLowerCase()}`,
          name: "Router Course Graduate",
          criteria: { type: "course_completed", courseId },
          active: true,
        },
      });

      await consumeInboundEvent(prisma, {
        sourceEventId: newId(),
        eventType: "CourseCompleted",
        payload: { enrollmentId: newId(), personId: p.id, courseId, completedAt: new Date().toISOString() },
      });

      await prisma.badge.update({ where: { id: badgeId }, data: { active: false } });

      // publicProcedure: no session needed, but a caller context still works fine.
      const profile = await callerFor(p).getPersonGamificationProfile({ personId: p.id });
      const badgeEntry = profile.badges.find((b) => b.badge.id === badgeId);
      expect(badgeEntry).toBeDefined();
      expect(badgeEntry?.badge.active).toBe(false);
    });

    it("listBadges defaults to activeOnly and excludes a deactivated badge unless asked otherwise", async () => {
      const badgeId = newId();
      badgeIds.push(badgeId);
      await prisma.badge.create({
        data: {
          id: badgeId,
          slug: `router-listbadges-${badgeId.toLowerCase()}`,
          name: "Router List Badges",
          criteria: { type: "points_total", threshold: 999999 },
          active: false,
        },
      });

      const caller = callerFor(await person());
      const activeOnly = await caller.listBadges({ activeOnly: true });
      expect(activeOnly.map((b) => b.id)).not.toContain(badgeId);

      const all = await caller.listBadges({ activeOnly: false });
      expect(all.map((b) => b.id)).toContain(badgeId);
    });
  });

  describe("staff-only mutations: adminAdjustPoints / adminAwardBadge", () => {
    it("adminAdjustPoints requires org_admin — a regular person is FORBIDDEN, an org_admin succeeds", async () => {
      const target = await person();
      const outsider = await person();
      const admin = await orgAdmin();

      await expect(
        callerFor(outsider).adminAdjustPoints({ personId: target.id, points: 50, reason: "test" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const result = await callerFor(admin).adminAdjustPoints({
        personId: target.id,
        points: 50,
        reason: "Manual correction for router test",
      });
      expect(result.ledgerEntryId).toBeTruthy();

      const balance = await prisma.pointsBalance.findUnique({ where: { personId: target.id } });
      expect(balance?.totalPoints).toBe(BigInt(50));
    });

    it("adminAdjustPoints rejects a whitespace-only reason as BAD_REQUEST", async () => {
      const admin = await orgAdmin();
      const target = await person();
      await expect(
        callerFor(admin).adminAdjustPoints({ personId: target.id, points: 10, reason: "   " }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("adminAwardBadge requires org_admin, is idempotent, and 404s for an unknown badge", async () => {
      const target = await person();
      const outsider = await person();
      const admin = await orgAdmin();
      const badgeId = newId();
      badgeIds.push(badgeId);
      await prisma.badge.create({
        data: {
          id: badgeId,
          slug: `router-admin-award-${badgeId.toLowerCase()}`,
          name: "Router Admin Award",
          criteria: { type: "points_total", threshold: 999999 },
          active: true,
        },
      });

      await expect(
        callerFor(outsider).adminAwardBadge({ personId: target.id, badgeId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const first = await callerFor(admin).adminAwardBadge({ personId: target.id, badgeId });
      expect(first.alreadyAwarded).toBe(false);
      expect(first.badgeAwardId).toBeTruthy();

      const second = await callerFor(admin).adminAwardBadge({ personId: target.id, badgeId });
      expect(second.alreadyAwarded).toBe(true);

      await expect(
        callerFor(admin).adminAwardBadge({ personId: target.id, badgeId: newId() }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
