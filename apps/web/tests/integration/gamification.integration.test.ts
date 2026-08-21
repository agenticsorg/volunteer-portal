import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import {
  consumeInboundEvent,
  getLeaderboard,
  getPersonGamificationProfile,
  rebuildLeaderboardSnapshot,
  recordPointsForEvent,
  type InboundEvent,
} from "@/modules/gamification";
import { createPerson } from "./helpers/identityFixtures";

// Exercises the Phase 5 Gamification consumer/leaderboard pipeline end to
// end against a real Postgres. Covers the phase's own completion bar
// verbatim:
//   - "replaying the same HoursApproved event twice awards points exactly
//     once" (the explicit idempotency test).
//   - "no leaderboard API path can return an unscoped, platform-wide
//     ranking — assert this at the API layer itself."
//   - "a badge, once awarded, remains visible on a person's profile even
//     after the badge's own definition is later deactivated."
// Inbound events are synthesized directly in the `HoursApproved`/
// `CourseCompleted`/`ModuleCompleted` payload shape `volunteering`/
// `training`'s own producers write (docs/ddd/gamification.md's
// Integration & Anti-Corruption Notes) — this is the anti-corruption
// boundary `consumeInboundEvent` is the entry point for; a future
// worker task supplies these same shapes after reading them off
// `volunteering.domain_events`/`training.domain_events`.
describe("Gamification (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const badgeIds: string[] = [];

  afterAll(async () => {
    await prisma.gamificationDomainEvent.deleteMany({});
    await prisma.gamificationProcessedEvent.deleteMany({});
    await prisma.leaderboardSnapshot.deleteMany({});
    await prisma.badgeAward.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.badge.deleteMany({ where: { id: { in: badgeIds } } });
    await prisma.streak.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.pointsLedgerEntry.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.pointsBalance.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function person() {
    const p = await createPerson(prisma, { displayName: "Gamification Test Person" });
    personIds.push(p.id);
    return p;
  }

  function hoursApprovedEvent(overrides: {
    personId: string;
    sourceEventId?: string;
    durationMinutes?: number;
    approvedAt?: Date;
  }): InboundEvent {
    return {
      sourceEventId: overrides.sourceEventId ?? newId(),
      eventType: "HoursApproved",
      payload: {
        hourEntryId: newId(),
        personId: overrides.personId,
        opportunityId: newId(),
        shiftId: newId(),
        chapterId: null,
        durationMinutes: overrides.durationMinutes ?? 60,
        approverPersonId: newId(),
        approvedAt: (overrides.approvedAt ?? new Date()).toISOString(),
      },
    };
  }

  function courseCompletedEvent(overrides: {
    personId: string;
    courseId?: string;
    sourceEventId?: string;
    completedAt?: Date;
  }): InboundEvent {
    return {
      sourceEventId: overrides.sourceEventId ?? newId(),
      eventType: "CourseCompleted",
      payload: {
        enrollmentId: newId(),
        personId: overrides.personId,
        courseId: overrides.courseId ?? newId(),
        completedAt: (overrides.completedAt ?? new Date()).toISOString(),
      },
    };
  }

  describe("idempotent event consumption (ADR-0009)", () => {
    it("replaying the same HoursApproved event twice awards points exactly once", async () => {
      const p = await person();
      const event = hoursApprovedEvent({ personId: p.id, durationMinutes: 120 }); // -> 20 points

      const first = await consumeInboundEvent(prisma, event);
      expect(first).toEqual({ processed: true, recognized: true });

      const second = await consumeInboundEvent(prisma, event); // exact same sourceEventId
      expect(second).toEqual({ processed: false, recognized: true });

      const entries = await prisma.pointsLedgerEntry.findMany({ where: { personId: p.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0].points).toBe(20);

      const balance = await prisma.pointsBalance.findUnique({ where: { personId: p.id } });
      expect(balance?.totalPoints).toBe(BigInt(20));

      const published = await prisma.gamificationDomainEvent.findMany({
        where: { eventType: "PointsAwarded", aggregateId: entries[0].id },
      });
      expect(published).toHaveLength(1); // published exactly once too, not once per attempted replay
    });

    it("recordPointsForEvent's own (sourceEventType, sourceEventId) backstop recovers within the transaction instead of aborting it", async () => {
      // Exercises RecordPointsForEvent's *own* independent idempotency
      // backstop directly (docs/ddd/gamification.md's Integration Notes,
      // point 3) — not the `processed_events` check `consumeInboundEvent`
      // already performs first, which would short-circuit before this
      // function's own unique-constraint guard ever gets a chance to run.
      // Regression test: this call used to throw Postgres error 25P02
      // ("current transaction is aborted") on the second write below,
      // because the caught P2002 from the duplicate `create()` left the
      // surrounding transaction unusable for anything that ran afterward.
      const p = await person();
      const sourceEventId = newId();

      await prisma.$transaction(async (tx) => {
        const first = await recordPointsForEvent(tx, {
          personId: p.id,
          points: 15,
          sourceEventType: "HoursApproved",
          sourceEventId,
        });
        expect(first.inserted).toBe(true);

        const second = await recordPointsForEvent(tx, {
          personId: p.id,
          points: 15,
          sourceEventType: "HoursApproved",
          sourceEventId, // same key -> hits the ledger's own unique constraint
        });
        expect(second.inserted).toBe(false);
        expect(second.totalPoints).toBe(BigInt(15)); // unchanged by the rejected duplicate

        // Proves the transaction is still healthy after the caught
        // duplicate: a further, unrelated write in the same transaction
        // must still succeed rather than failing with 25P02.
        const balanceAfter = await tx.pointsBalance.findUniqueOrThrow({ where: { personId: p.id } });
        expect(balanceAfter.totalPoints).toBe(BigInt(15));
      });

      const entries = await prisma.pointsLedgerEntry.findMany({ where: { personId: p.id } });
      expect(entries).toHaveLength(1); // the duplicate never produced a second row
    });

    it("an unrecognized event type is a no-op, not an error", async () => {
      const p = await person();
      const result = await consumeInboundEvent(prisma, {
        sourceEventId: newId(),
        eventType: "SomethingThisConsumerDoesNotSubscribeTo",
        payload: { personId: p.id },
      });
      expect(result).toEqual({ processed: false, recognized: false });
    });
  });

  describe("badges", () => {
    it("a badge remains visible on a person's profile after its own definition is deactivated", async () => {
      const p = await person();
      const courseId = newId();
      const badgeId = newId();
      badgeIds.push(badgeId);

      await prisma.badge.create({
        data: {
          id: badgeId,
          slug: `course-graduate-${badgeId.toLowerCase()}`,
          name: "Course Graduate",
          criteria: { type: "course_completed", courseId },
          active: true,
        },
      });

      await consumeInboundEvent(prisma, courseCompletedEvent({ personId: p.id, courseId }));

      const award = await prisma.badgeAward.findUnique({
        where: { personId_badgeId: { personId: p.id, badgeId } },
      });
      expect(award).not.toBeNull();

      const publishedBadgeAwarded = await prisma.gamificationDomainEvent.findMany({
        where: { eventType: "BadgeAwarded", aggregateId: award!.id },
      });
      expect(publishedBadgeAwarded).toHaveLength(1);

      // Retire the badge definition.
      await prisma.badge.update({ where: { id: badgeId }, data: { active: false } });

      const profile = await getPersonGamificationProfile(prisma, p.id);
      const badgeEntry = profile.badges.find((b) => b.badge.id === badgeId);
      expect(badgeEntry).toBeDefined();
      expect(badgeEntry?.badge.active).toBe(false); // definition is retired...
      // ...but the award itself is still there, unaffected.
      expect(badgeEntry?.badgeAwardId).toBe(award!.id);
    });

    it("re-processing the same qualifying event a second time does not duplicate the award", async () => {
      const p = await person();
      const courseId = newId();
      const badgeId = newId();
      badgeIds.push(badgeId);

      await prisma.badge.create({
        data: {
          id: badgeId,
          slug: `second-course-graduate-${badgeId.toLowerCase()}`,
          name: "Course Graduate 2",
          criteria: { type: "course_completed", courseId },
          active: true,
        },
      });

      const event = courseCompletedEvent({ personId: p.id, courseId });
      await consumeInboundEvent(prisma, event);
      await consumeInboundEvent(prisma, event); // redelivery

      const awards = await prisma.badgeAward.findMany({ where: { personId: p.id, badgeId } });
      expect(awards).toHaveLength(1);
    });
  });

  describe("leaderboards — team/challenge-scoped only", () => {
    it("rejects an unscoped/global leaderboard request at the application layer, even bypassing the type system", async () => {
      // @ts-expect-error — deliberately bypassing the type system, the same
      // way a malformed request body would once the API layer exists.
      await expect(getLeaderboard(prisma, { scope: { scopeType: "global", scopeId: "x" } })).rejects.toThrow(
        /never|global|team.*challenge/i,
      );
      await expect(
        rebuildLeaderboardSnapshot(prisma, {
          // @ts-expect-error — same as above, for the write side.
          scope: { scopeType: "global", scopeId: "x" },
          memberPersonIds: [],
          periodStart: new Date(0),
          periodEnd: new Date(),
        }),
      ).rejects.toThrow(/never|global|team.*challenge/i);
    });

    it("ranks a team's members by points earned within the snapshot window, including 0-point members", async () => {
      const alice = await person();
      const bob = await person();
      const carol = await person(); // never earns any points

      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: alice.id, durationMinutes: 600 })); // 100 pts
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: bob.id, durationMinutes: 300 })); // 50 pts

      const teamId = newId();
      const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await rebuildLeaderboardSnapshot(prisma, {
        scope: { scopeType: "team", scopeId: teamId },
        memberPersonIds: [alice.id, bob.id, carol.id],
        periodStart,
        periodEnd,
      });

      const board = await getLeaderboard(prisma, { scope: { scopeType: "team", scopeId: teamId }, periodStart });
      expect(board.entries).toHaveLength(3);
      expect(board.entries.map((e) => e.personId)).toEqual([alice.id, bob.id, carol.id]);
      expect(board.entries[0]).toMatchObject({ personId: alice.id, rank: 1, points: 100 });
      expect(board.entries[1]).toMatchObject({ personId: bob.id, rank: 2, points: 50 });
      expect(board.entries[2]).toMatchObject({ personId: carol.id, rank: 3, points: 0 });
    });

    it("a leaderboard scoped to one team never includes another team's member ranking", async () => {
      const teamAMember = await person();
      const teamBMember = await person();
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: teamAMember.id, durationMinutes: 60 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: teamBMember.id, durationMinutes: 60 }));

      const teamAId = newId();
      const teamBId = newId();
      const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await rebuildLeaderboardSnapshot(prisma, {
        scope: { scopeType: "team", scopeId: teamAId },
        memberPersonIds: [teamAMember.id],
        periodStart,
        periodEnd,
      });
      await rebuildLeaderboardSnapshot(prisma, {
        scope: { scopeType: "team", scopeId: teamBId },
        memberPersonIds: [teamBMember.id],
        periodStart,
        periodEnd,
      });

      const boardA = await getLeaderboard(prisma, { scope: { scopeType: "team", scopeId: teamAId }, periodStart });
      expect(boardA.entries.map((e) => e.personId)).toEqual([teamAMember.id]);
    });
  });

  describe("points_ledger_entry is append-only at the database level (PointsLedgerEntry invariant 1)", () => {
    it("a direct UPDATE is silently a no-op (CREATE RULE ... DO INSTEAD NOTHING) and leaves the row unchanged", async () => {
      const p = await person();
      const event = hoursApprovedEvent({ personId: p.id, durationMinutes: 60 });
      await consumeInboundEvent(prisma, event);
      const before = await prisma.pointsLedgerEntry.findFirstOrThrow({ where: { personId: p.id } });

      // Unlike admin.audit_log's raising trigger, the Schema Sketch's rule
      // for this table is a deliberately silent DO INSTEAD NOTHING — the
      // statement itself does not throw, but the row must be provably
      // unchanged afterwards.
      await prisma.$executeRaw`UPDATE gamification.points_ledger_entry SET points = 999999 WHERE id = ${before.id}`;

      const after = await prisma.pointsLedgerEntry.findUniqueOrThrow({ where: { id: before.id } });
      expect(after).toEqual(before);
      expect(after.points).toBe(10);
    });

    it("a direct DELETE is silently a no-op and the row remains present", async () => {
      const p = await person();
      const event = hoursApprovedEvent({ personId: p.id, durationMinutes: 60 });
      await consumeInboundEvent(prisma, event);
      const before = await prisma.pointsLedgerEntry.findFirstOrThrow({ where: { personId: p.id } });

      await prisma.$executeRaw`DELETE FROM gamification.points_ledger_entry WHERE id = ${before.id}`;

      const stillThere = await prisma.pointsLedgerEntry.findUnique({ where: { id: before.id } });
      expect(stillThere).not.toBeNull();
    });
  });

  describe("streaks — forgiveness/grace mechanic", () => {
    it("consecutive weekly HoursApproved events extend a shift_cadence streak", async () => {
      const p = await person();
      const week1 = new Date("2026-02-02T10:00:00.000Z"); // Monday
      const week2 = new Date("2026-02-09T10:00:00.000Z");

      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: week1 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: week2 }));

      const streak = await prisma.streak.findUnique({
        where: { personId_activityType: { personId: p.id, activityType: "shift_cadence" } },
      });
      expect(streak?.currentLength).toBe(2);
      expect(streak?.status).toBe("active");

      const extended = await prisma.gamificationDomainEvent.findMany({
        where: { eventType: "StreakExtended", aggregateId: streak!.id },
      });
      expect(extended).toHaveLength(2);
    });

    it("a single missed week is forgiven by a freeze, not a broken streak", async () => {
      const p = await person();
      const week1 = new Date("2026-03-02T10:00:00.000Z"); // Monday
      const week2 = new Date("2026-03-09T10:00:00.000Z");
      const week4 = new Date("2026-03-23T10:00:00.000Z"); // week 3 skipped entirely

      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: week1 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: week2 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: week4 }));

      const streak = await prisma.streak.findUnique({
        where: { personId_activityType: { personId: p.id, activityType: "shift_cadence" } },
      });
      expect(streak?.status).toBe("frozen");
      expect(streak?.currentLength).toBe(2); // preserved, not broken
      expect(streak?.freezesAvailable).toBe(1); // started at 2, consumed 1

      const frozenEvents = await prisma.gamificationDomainEvent.findMany({
        where: { eventType: "StreakFrozen", aggregateId: streak!.id },
      });
      expect(frozenEvents).toHaveLength(1);
    });

    it("a missed week with no freezes remaining breaks the streak", async () => {
      const p = await person();
      // Consume freezes with two separate multi-week gaps before exhausting them.
      const w1 = new Date("2026-04-06T10:00:00.000Z");
      const w3 = new Date("2026-04-20T10:00:00.000Z"); // gap 1 -> freeze
      const w5 = new Date("2026-05-04T10:00:00.000Z"); // gap 2 -> freeze
      const w7 = new Date("2026-05-18T10:00:00.000Z"); // gap 3 -> no freezes left -> broken

      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: w1 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: w3 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: w5 }));
      await consumeInboundEvent(prisma, hoursApprovedEvent({ personId: p.id, approvedAt: w7 }));

      const streak = await prisma.streak.findUnique({
        where: { personId_activityType: { personId: p.id, activityType: "shift_cadence" } },
      });
      expect(streak?.status).toBe("broken");
      expect(streak?.currentLength).toBe(0);
      expect(streak?.freezesAvailable).toBe(0);

      const brokenEvents = await prisma.gamificationDomainEvent.findMany({
        where: { eventType: "StreakBroken", aggregateId: streak!.id },
      });
      expect(brokenEvents).toHaveLength(1);
    });
  });
});
