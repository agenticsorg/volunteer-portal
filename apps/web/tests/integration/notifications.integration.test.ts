import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import {
  handleHoursApproved,
  handleBadgeAwarded,
  handleStreakBroken,
  handleCourseCompleted,
  handleCertificateIssued,
  handleKudosGiven,
  handleMentorshipStarted,
  handleModerationActionTaken,
  setNotificationPreference,
  processDeliveryJob,
  ForbiddenActionError,
  type ResendAdapter,
  type HoursApprovedPayload,
} from "@/modules/notifications";
import { createPerson } from "./helpers/identityFixtures";
import { createOpportunityDirect } from "./helpers/volunteeringFixtures";
import { createCourseDirect } from "./helpers/trainingFixtures";

// Exercises the Phase 8 Notifications consumer/consent/delivery pipeline
// end to end against a real Postgres. Covers the phase's own completion
// bar verbatim (docs/plans/implementation-plan.md):
//   - opting out of a notification type BEFORE the triggering event fires
//     means it is NEVER QUEUED (no Notification row is ever created).
//   - opting out AFTER it's queued but before delivery means it is NEVER
//     SENT (a Notification row exists but delivery is blocked/skipped) —
//     tested as a SEPARATE test from the one above, per the brief.
//   - firing each of the eight upstream event types
//     (docs/plans/implementation-plan.md's Phase 8 Build item 2 /
//     docs/ddd/notifications.md's "Consumed" table) produces a
//     corresponding Notification row.
// Inbound event payloads are synthesized directly in the shape each
// source module's own producer writes (docs/ddd/notifications.md's
// Integration & Anti-Corruption Notes) — same precedent as
// `gamification.integration.test.ts`'s own `hoursApprovedEvent`/
// `courseCompletedEvent` builders.
describe("Notifications (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const badgeIds: string[] = [];
  const courseIds: string[] = [];
  const opportunityIds: string[] = [];

  afterAll(async () => {
    // notifications.* tables are exclusive to this suite (no other phase's
    // tests write to them) — safe to wipe wholesale, same precedent as
    // gamification.integration.test.ts's own afterAll.
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.notificationPreference.deleteMany({});
    await prisma.notificationsProcessedEvent.deleteMany({});
    await prisma.notificationsDomainEvent.deleteMany({});
    await prisma.badgeAward.deleteMany({ where: { badgeId: { in: badgeIds } } });
    await prisma.badge.deleteMany({ where: { id: { in: badgeIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function person(overrides: Partial<{ displayName: string }> = {}) {
    const p = await createPerson(prisma, { displayName: "Notifications Test Person", ...overrides });
    personIds.push(p.id);
    return p;
  }

  async function opportunity() {
    const o = await createOpportunityDirect(prisma);
    opportunityIds.push(o.id);
    return o;
  }

  async function course() {
    const c = await createCourseDirect(prisma);
    courseIds.push(c.id);
    return c;
  }

  async function badgeAndAward(personId: string) {
    const badgeId = newId();
    badgeIds.push(badgeId);
    await prisma.badge.create({
      data: { id: badgeId, slug: `badge-${badgeId.toLowerCase()}`, name: "Test Badge", criteria: { type: "manual" }, active: true },
    });
    const badgeAwardId = newId();
    await prisma.badgeAward.create({ data: { id: badgeAwardId, personId, badgeId } });
    return { badgeId, badgeAwardId };
  }

  function fakeAdapter(overrides: Partial<ResendAdapter> = {}): ResendAdapter {
    return {
      async sendTransactionalEmail() {
        return { providerMessageId: `fake-${newId()}` };
      },
      verifyWebhookSignature() {
        return true;
      },
      ...overrides,
    };
  }

  async function hoursApprovedFor(p: { id: string }, opp: { id: string }, sourceEventId: string) {
    const payload: HoursApprovedPayload = {
      hourEntryId: newId(),
      personId: p.id,
      opportunityId: opp.id,
      shiftId: null,
      chapterId: null,
      durationMinutes: 90,
      approverPersonId: newId(),
      approvedAt: new Date().toISOString(),
    };
    return handleHoursApproved(prisma, payload, sourceEventId);
  }

  describe("setNotificationPreference authorization (notification.preference.manage)", () => {
    it("rejects setting another person's preference (ForbiddenActionError), same precedent as every other module's ownership-scoped action", async () => {
      const owner = await person();
      const caller = await person();

      await expect(
        setNotificationPreference(prisma, {
          caller: { id: caller.id, status: "active" },
          personId: owner.id,
          type: "hours_approved",
          channel: "email",
          enabled: false,
        }),
      ).rejects.toThrow(ForbiddenActionError);

      // No row was created or changed for the target person.
      const row = await prisma.notificationPreference.findUnique({
        where: { personId_type_channel: { personId: owner.id, type: "hours_approved", channel: "email" } },
      });
      expect(row).toBeNull();
    });
  });

  describe("double-gated consent (Notification invariant 1) — both timings tested explicitly, not conflated", () => {
    it("opting out of a type on BOTH channels BEFORE the triggering event fires means the Notification is never queued", async () => {
      const p = await person();
      const opp = await opportunity();

      await setNotificationPreference(prisma, {
        caller: { id: p.id, status: "active" },
        personId: p.id,
        type: "hours_approved",
        channel: "email",
        enabled: false,
      });
      await setNotificationPreference(prisma, {
        caller: { id: p.id, status: "active" },
        personId: p.id,
        type: "hours_approved",
        channel: "in_app",
        enabled: false,
      });

      const sourceEventId = newId();
      const result = await hoursApprovedFor(p, opp, sourceEventId);

      // The upstream event was still fully handled (not left pending for
      // retry) — a suppressed outcome is a silent no-op, not a failure.
      expect(result.processed).toBe(true);
      const processedEvent = await prisma.notificationsProcessedEvent.findUnique({ where: { id: sourceEventId } });
      expect(processedEvent).not.toBeNull();

      // ...but zero Notification rows exist for this event, ever.
      const rows = await prisma.notification.findMany({ where: { sourceEventId } });
      expect(rows).toHaveLength(0);
      const attempts = await prisma.deliveryAttempt.findMany({ where: { notification: { sourceEventId } } });
      expect(attempts).toHaveLength(0);
    });

    it("opting out AFTER a Notification is already queued but BEFORE delivery blocks the email send — the row exists, delivery is skipped", async () => {
      const p = await person();
      const opp = await opportunity();
      const sourceEventId = newId();

      // Default preferences: hours_approved is enabled on both channels,
      // so this queues normally.
      await hoursApprovedFor(p, opp, sourceEventId);

      const notification = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
      expect(notification.channel).toBe("both");

      const emailAttempt = await prisma.deliveryAttempt.findFirstOrThrow({
        where: { notificationId: notification.id, channel: "email" },
      });
      expect(emailAttempt.status).toBe("pending");

      // The person changes their mind in the window between queue and
      // delivery — this must be re-checked independently at delivery time.
      await setNotificationPreference(prisma, {
        caller: { id: p.id, status: "active" },
        personId: p.id,
        type: "hours_approved",
        channel: "email",
        enabled: false,
      });

      const sendSpy = vi.fn();
      const outcome = await processDeliveryJob(prisma, emailAttempt.id, fakeAdapter({ sendTransactionalEmail: sendSpy }));

      expect(outcome.outcome).toBe("suppressed_preference_revoked");
      expect(sendSpy).not.toHaveBeenCalled(); // Resend is never contacted once the delivery-time gate trips

      const updatedAttempt = await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: emailAttempt.id } });
      expect(updatedAttempt.status).toBe("failed");
      expect(updatedAttempt.errorMessage).toBe("preference_revoked");

      // The Notification row itself is untouched — it was queued, and stays queued.
      const stillThere = await prisma.notification.findUnique({ where: { id: notification.id } });
      expect(stillThere).not.toBeNull();
    });
  });

  describe("idempotent consumption (ADR-0009)", () => {
    it("redelivering the same source event does not duplicate the Notification", async () => {
      const p = await person();
      const opp = await opportunity();
      const sourceEventId = newId();
      const payload: HoursApprovedPayload = {
        hourEntryId: newId(),
        personId: p.id,
        opportunityId: opp.id,
        shiftId: null,
        chapterId: null,
        durationMinutes: 60,
        approverPersonId: newId(),
        approvedAt: new Date().toISOString(),
      };

      const first = await handleHoursApproved(prisma, payload, sourceEventId);
      expect(first.processed).toBe(true);
      const second = await handleHoursApproved(prisma, payload, sourceEventId); // redelivery, same sourceEventId
      expect(second.processed).toBe(false);

      const rows = await prisma.notification.findMany({ where: { sourceEventId } });
      expect(rows).toHaveLength(1);
    });
  });

  describe("Resend adapter — real, unconfigured environment (no RESEND_API_KEY)", () => {
    it("ProcessDeliveryJob against the real adapter marks the attempt failed rather than faking a send", async () => {
      const originalKey = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      try {
        const p = await person();
        const opp = await opportunity();
        const sourceEventId = newId();
        await hoursApprovedFor(p, opp, sourceEventId);

        const notification = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
        const emailAttempt = await prisma.deliveryAttempt.findFirstOrThrow({
          where: { notificationId: notification.id, channel: "email" },
        });

        // No adapter override — exercises the real default `resendAdapter`.
        const outcome = await processDeliveryJob(prisma, emailAttempt.id);

        expect(outcome.outcome).toBe("failed");
        expect(outcome.errorMessage).toMatch(/RESEND_API_KEY/);

        const updated = await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: emailAttempt.id } });
        expect(updated.status).toBe("failed");
        expect(updated.providerMessageId).toBeNull();
        expect(updated.errorMessage).toMatch(/RESEND_API_KEY/);
      } finally {
        if (originalKey === undefined) delete process.env.RESEND_API_KEY;
        else process.env.RESEND_API_KEY = originalKey;
      }
    });
  });

  describe("all eight consumed upstream event types produce a corresponding Notification", () => {
    it("HoursApproved -> hours_approved", async () => {
      const p = await person();
      const opp = await opportunity();
      const sourceEventId = newId();
      await hoursApprovedFor(p, opp, sourceEventId);

      const row = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
      expect(row.type).toBe("hours_approved");
      expect(row.recipientPersonId).toBe(p.id);
      expect(row.sourceContext).toBe("volunteering");
      // Also confirms in_app delivery is synchronous: sent in the same
      // transaction as the Notification (DeliveryAttempt invariant).
      const inAppAttempt = await prisma.deliveryAttempt.findFirstOrThrow({ where: { notificationId: row.id, channel: "in_app" } });
      expect(inAppAttempt.status).toBe("sent");
      expect(inAppAttempt.attemptedAt).not.toBeNull();
    });

    it("BadgeAwarded -> badge_awarded", async () => {
      const p = await person();
      const { badgeId, badgeAwardId } = await badgeAndAward(p.id);
      const sourceEventId = newId();
      await handleBadgeAwarded(prisma, { personId: p.id, badgeId, badgeAwardId, awardedAt: new Date().toISOString() }, sourceEventId);

      const row = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
      expect(row.type).toBe("badge_awarded");
      expect(row.recipientPersonId).toBe(p.id);
      expect(row.sourceContext).toBe("gamification");
    });

    it("StreakBroken -> streak_broken", async () => {
      const p = await person();
      const sourceEventId = newId();
      await handleStreakBroken(prisma, { personId: p.id, activityType: "shift_cadence", previousLength: 4 }, sourceEventId);

      const row = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
      expect(row.type).toBe("streak_broken");
      expect(row.recipientPersonId).toBe(p.id);
      expect(row.sourceContext).toBe("gamification");
    });

    it("CourseCompleted -> course_completed", async () => {
      const p = await person();
      const c = await course();
      const sourceEventId = newId();
      await handleCourseCompleted(
        prisma,
        { enrollmentId: newId(), personId: p.id, courseId: c.id, completedAt: new Date().toISOString() },
        sourceEventId,
      );

      const row = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
      expect(row.type).toBe("course_completed");
      expect(row.recipientPersonId).toBe(p.id);
      expect(row.sourceContext).toBe("training");
    });

    it("CertificateIssued -> certificate_issued", async () => {
      const p = await person();
      const c = await course();
      const sourceEventId = newId();
      await handleCertificateIssued(
        prisma,
        { certificateId: newId(), personId: p.id, courseId: c.id, certificateNumber: "CERT-0001" },
        sourceEventId,
      );

      const row = await prisma.notification.findFirstOrThrow({ where: { sourceEventId } });
      expect(row.type).toBe("certificate_issued");
      expect(row.recipientPersonId).toBe(p.id);
      expect(row.sourceContext).toBe("training");
    });

    it("KudosGiven -> kudos_given (recipient only, never the giver)", async () => {
      const from = await person();
      const to = await person();
      const sourceEventId = newId();
      await handleKudosGiven(
        prisma,
        { kudosId: newId(), fromPersonId: from.id, toPersonId: to.id, achievementRefType: null, achievementRefId: null },
        sourceEventId,
      );

      const rows = await prisma.notification.findMany({ where: { sourceEventId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("kudos_given");
      expect(rows[0]!.recipientPersonId).toBe(to.id);
      expect(rows[0]!.sourceContext).toBe("community");
    });

    it("MentorshipStarted -> mentorship_started (queues one Notification per party)", async () => {
      const mentor = await person();
      const mentee = await person();
      const sourceEventId = newId();
      await handleMentorshipStarted(prisma, { mentorshipId: newId(), mentorPersonId: mentor.id, menteePersonId: mentee.id }, sourceEventId);

      const rows = await prisma.notification.findMany({ where: { sourceEventId } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.type === "mentorship_started")).toBe(true);
      expect(rows.map((r) => r.recipientPersonId).sort()).toEqual([mentor.id, mentee.id].sort());
    });

    it("ModerationActionTaken -> moderation_action (target only, never the moderator)", async () => {
      const target = await person();
      const sourceEventId = newId();
      await handleModerationActionTaken(
        prisma,
        {
          actionId: newId(),
          actionType: "warn",
          targetPersonId: target.id,
          moderatorPersonId: newId(),
          scopeType: "org",
          scopeId: null,
          endsAt: null,
        },
        sourceEventId,
      );

      const rows = await prisma.notification.findMany({ where: { sourceEventId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("moderation_action");
      expect(rows[0]!.recipientPersonId).toBe(target.id);
      expect(rows[0]!.sourceContext).toBe("moderation");
    });
  });
});
