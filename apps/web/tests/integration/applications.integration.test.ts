import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyToShift,
  decideApplication,
  withdrawApplication,
  DuplicateApplicationError,
  ForbiddenActionError,
} from "@/modules/volunteering";
import { createPerson, grantRoleDirect, createChapterDirect } from "./helpers/identityFixtures";
import {
  callerSubject,
  createApplicationDirect,
  createOpportunityDirect,
  createShiftDirect,
} from "./helpers/volunteeringFixtures";

// Exercises ApplyToShift/DecideApplication/WithdrawApplication (Key Use
// Cases 4-6): the Shift.capacity/acceptedCount concurrency invariant, and
// Waitlist Promotion firing when an accepted Application is withdrawn —
// the Phase 3 completion bar's own acceptance criteria, word for word.
describe("applyToShift / decideApplication / withdrawApplication (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const opportunityIds: string[] = [];
  const track = <T extends { id: string }>(bucket: string[], row: T) => (bucket.push(row.id), row);

  afterAll(async () => {
    // Scoped to this file's own opportunityIds — never an unscoped
    // deleteMany({}), which would race with other integration test files'
    // still-running tests against the same shared testcontainer Postgres
    // (Vitest runs integration test files in parallel by default) and
    // wipe their in-progress rows out from under them.
    await prisma.volunteeringDomainEvent.deleteMany({ where: { aggregateId: { in: opportunityIds } } });
    await prisma.application.deleteMany({ where: { shift: { opportunityId: { in: opportunityIds } } } });
    await prisma.hourEntry.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.shift.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function setup(capacity: number) {
    const chapter = track(chapterIds, await createChapterDirect(prisma));
    const lead = track(personIds, await createPerson(prisma, { displayName: "Chapter Lead" }));
    await grantRoleDirect(prisma, {
      subjectId: lead.id,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: chapter.id,
      grantedBy: lead.id,
    });
    const opportunity = track(
      opportunityIds,
      await createOpportunityDirect(prisma, { chapterId: chapter.id, createdByPersonId: lead.id }),
    );
    const shift = await createShiftDirect(prisma, { opportunityId: opportunity.id, capacity });
    return { chapter, lead, opportunity, shift };
  }

  it("accepts an applicant when capacity is available, emitting ApplicationAccepted and incrementing acceptedCount", async () => {
    const { lead, shift } = await setup(1);
    const applicant = track(personIds, await createPerson(prisma, { displayName: "Applicant" }));

    const { applicationId } = await applyToShift(prisma, { applicantPersonId: applicant.id, shiftId: shift.id });

    const { outcome } = await decideApplication(prisma, {
      caller: callerSubject(lead),
      applicationId,
      decision: "accept",
    });
    expect(outcome).toBe("accepted");

    const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.status).toBe("accepted");
    expect(row.decidedByPersonId).toBe(lead.id);

    const updatedShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(updatedShift.acceptedCount).toBe(1);

    const events = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "Application", aggregateId: applicationId, eventType: "ApplicationAccepted" },
    });
    expect(events).toHaveLength(1);
  });

  it("forces the outcome to waitlisted once capacity is full, without exceeding capacity", async () => {
    const { lead, shift } = await setup(1);
    const first = track(personIds, await createPerson(prisma, { displayName: "First Applicant" }));
    const second = track(personIds, await createPerson(prisma, { displayName: "Second Applicant" }));

    const firstApp = await applyToShift(prisma, { applicantPersonId: first.id, shiftId: shift.id });
    await decideApplication(prisma, { caller: callerSubject(lead), applicationId: firstApp.applicationId, decision: "accept" });

    const secondApp = await applyToShift(prisma, { applicantPersonId: second.id, shiftId: shift.id });
    const { outcome } = await decideApplication(prisma, {
      caller: callerSubject(lead),
      applicationId: secondApp.applicationId,
      decision: "accept",
    });

    expect(outcome).toBe("waitlisted");

    const updatedShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(updatedShift.acceptedCount).toBe(1);
    expect(updatedShift.acceptedCount).toBeLessThanOrEqual(updatedShift.capacity);

    const events = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "Application", aggregateId: secondApp.applicationId, eventType: "ApplicationWaitlisted" },
    });
    expect(events).toHaveLength(1);
  });

  it("promotes the earliest waitlisted application to accepted when an accepted application is withdrawn", async () => {
    const { lead, shift } = await setup(1);
    const first = track(personIds, await createPerson(prisma, { displayName: "First Applicant" }));
    const second = track(personIds, await createPerson(prisma, { displayName: "Second Applicant" }));

    const firstApp = await applyToShift(prisma, { applicantPersonId: first.id, shiftId: shift.id });
    await decideApplication(prisma, { caller: callerSubject(lead), applicationId: firstApp.applicationId, decision: "accept" });

    const secondApp = await applyToShift(prisma, { applicantPersonId: second.id, shiftId: shift.id });
    const secondDecision = await decideApplication(prisma, {
      caller: callerSubject(lead),
      applicationId: secondApp.applicationId,
      decision: "accept",
    });
    expect(secondDecision.outcome).toBe("waitlisted");

    await withdrawApplication(prisma, { callerId: first.id, applicationId: firstApp.applicationId });

    const withdrawnRow = await prisma.application.findUniqueOrThrow({ where: { id: firstApp.applicationId } });
    expect(withdrawnRow.status).toBe("withdrawn");

    const promotedRow = await prisma.application.findUniqueOrThrow({ where: { id: secondApp.applicationId } });
    expect(promotedRow.status).toBe("accepted");

    const updatedShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(updatedShift.acceptedCount).toBe(1);

    const promotionEvents = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "Application", aggregateId: secondApp.applicationId, eventType: "ApplicationAccepted" },
    });
    expect(promotionEvents).toHaveLength(1);
    // Waitlist-promotion's ApplicationAccepted must carry the same payload
    // shape as a direct DecideApplication accept — opportunityId included
    // (docs/ddd/volunteering-opportunities.md Domain Events table).
    expect(promotionEvents[0]?.payload).toMatchObject({
      applicationId: secondApp.applicationId,
      shiftId: shift.id,
      opportunityId: shift.opportunityId,
      applicantPersonId: second.id,
    });

    const withdrawEvents = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "Application", aggregateId: firstApp.applicationId, eventType: "ApplicationWithdrawn" },
    });
    expect(withdrawEvents).toHaveLength(1);
  });

  it("promotes the earliest-by-appliedAt waitlisted application when multiple are waitlisted", async () => {
    const { lead, shift } = await setup(1);
    const accepted = track(personIds, await createPerson(prisma, { displayName: "Accepted Applicant" }));
    const laterWaitlisted = track(personIds, await createPerson(prisma, { displayName: "Later Waitlisted" }));
    const earlierWaitlisted = track(personIds, await createPerson(prisma, { displayName: "Earlier Waitlisted" }));

    const acceptedApp = await applyToShift(prisma, { applicantPersonId: accepted.id, shiftId: shift.id });
    await decideApplication(prisma, { caller: callerSubject(lead), applicationId: acceptedApp.applicationId, decision: "accept" });

    // Inserted out of appliedAt order to prove the promotion picks by
    // appliedAt, not insertion/creation order.
    const laterApp = await createApplicationDirect(prisma, {
      shiftId: shift.id,
      applicantPersonId: laterWaitlisted.id,
      status: "waitlisted",
      appliedAt: new Date(Date.now() + 60_000),
    });
    const earlierApp = await createApplicationDirect(prisma, {
      shiftId: shift.id,
      applicantPersonId: earlierWaitlisted.id,
      status: "waitlisted",
      appliedAt: new Date(Date.now() - 60_000),
    });

    await withdrawApplication(prisma, { callerId: accepted.id, applicationId: acceptedApp.applicationId });

    const promotedRow = await prisma.application.findUniqueOrThrow({ where: { id: earlierApp.id } });
    expect(promotedRow.status).toBe("accepted");

    const stillWaitlistedRow = await prisma.application.findUniqueOrThrow({ where: { id: laterApp.id } });
    expect(stillWaitlistedRow.status).toBe("waitlisted");

    const updatedShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(updatedShift.acceptedCount).toBe(1);
  });

  it("rejects a duplicate active application for the same (applicant, shift) pair", async () => {
    const { shift } = await setup(2);
    const applicant = track(personIds, await createPerson(prisma, { displayName: "Applicant" }));

    await applyToShift(prisma, { applicantPersonId: applicant.id, shiftId: shift.id });

    await expect(applyToShift(prisma, { applicantPersonId: applicant.id, shiftId: shift.id })).rejects.toThrow(
      DuplicateApplicationError,
    );
  });

  it("allows declining a waitlisted application (state diagram's waitlisted--decline-->declined arc)", async () => {
    const { lead, shift } = await setup(1);
    const applicant = track(personIds, await createPerson(prisma, { displayName: "Waitlisted Applicant" }));

    const application = await createApplicationDirect(prisma, {
      shiftId: shift.id,
      applicantPersonId: applicant.id,
      status: "waitlisted",
    });

    const { outcome } = await decideApplication(prisma, {
      caller: callerSubject(lead),
      applicationId: application.id,
      decision: "decline",
    });
    expect(outcome).toBe("declined");

    const row = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(row.status).toBe("declined");
    expect(row.decidedByPersonId).toBe(lead.id);

    const events = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "Application", aggregateId: application.id, eventType: "ApplicationDeclined" },
    });
    expect(events).toHaveLength(1);
  });

  it("still rejects accept/waitlist decisions against a non-pending application", async () => {
    const { lead, shift } = await setup(1);
    const applicant = track(personIds, await createPerson(prisma, { displayName: "Waitlisted Applicant" }));

    const application = await createApplicationDirect(prisma, {
      shiftId: shift.id,
      applicantPersonId: applicant.id,
      status: "waitlisted",
    });

    await expect(
      decideApplication(prisma, { caller: callerSubject(lead), applicationId: application.id, decision: "accept" }),
    ).rejects.toThrow(`Application "${application.id}" is "waitlisted", not "pending".`);

    await expect(
      decideApplication(prisma, { caller: callerSubject(lead), applicationId: application.id, decision: "waitlist" }),
    ).rejects.toThrow(`Application "${application.id}" is "waitlisted", not "pending".`);
  });

  it("denies decideApplication for a caller without chapter_lead/mentor/org_admin authority", async () => {
    const { shift } = await setup(1);
    const applicant = track(personIds, await createPerson(prisma, { displayName: "Applicant" }));
    const rando = track(personIds, await createPerson(prisma, { displayName: "Rando" }));

    const { applicationId } = await applyToShift(prisma, { applicantPersonId: applicant.id, shiftId: shift.id });

    await expect(
      decideApplication(prisma, { caller: callerSubject(rando), applicationId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenActionError);
  });
});
