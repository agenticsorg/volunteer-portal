import { PrismaClient, Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  submitHours,
  approveHours,
  rejectHours,
  ForbiddenActionError,
  HourEntryNotSubmittedError,
  SelfApprovalNotAllowedError,
  RejectionReasonRequiredError,
} from "@/modules/volunteering";
import { createPerson, grantRoleDirect, createChapterDirect } from "./helpers/identityFixtures";
import { callerSubject, createOpportunityDirect } from "./helpers/volunteeringFixtures";

// Exercises SubmitHours/ApproveHours/RejectHours (Key Use Cases 7-9) — the
// Phase 3 completion bar's own acceptance criteria: "an hour entry moves
// submitted -> approved with approver and timestamp recorded, and any
// attempt to mutate it afterward fails (write this as a negative test)"
// and "an integration test confirms HoursApproved events land reliably in
// volunteering.domain_events."
describe("submitHours / approveHours / rejectHours (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const opportunityIds: string[] = [];
  const track = <T extends { id: string }>(bucket: string[], row: T) => (bucket.push(row.id), row);

  afterAll(async () => {
    await prisma.volunteeringDomainEvent.deleteMany({});
    await prisma.hourEntry.deleteMany({});
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function setup() {
    const chapter = track(chapterIds, await createChapterDirect(prisma));
    const lead = track(personIds, await createPerson(prisma, { displayName: "Chapter Lead" }));
    await grantRoleDirect(prisma, {
      subjectId: lead.id,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: chapter.id,
      grantedBy: lead.id,
    });
    const volunteer = track(personIds, await createPerson(prisma, { displayName: "Volunteer" }));
    const opportunity = track(
      opportunityIds,
      await createOpportunityDirect(prisma, { chapterId: chapter.id, createdByPersonId: lead.id }),
    );
    return { chapter, lead, volunteer, opportunity };
  }

  it("moves submitted -> approved with approverPersonId/approvedAt recorded, and emits HoursApproved reliably", async () => {
    const { lead, volunteer, opportunity } = await setup();

    const startAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const endAt = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId: opportunity.id,
      shiftId: null,
      startAt,
      endAt,
      description: "Helped run the booth.",
    });

    await approveHours(prisma, { caller: callerSubject(lead), hourEntryId });

    const row = await prisma.hourEntry.findUniqueOrThrow({ where: { id: hourEntryId } });
    expect(row.status).toBe("approved");
    expect(row.approverPersonId).toBe(lead.id);
    expect(row.approvedAt).not.toBeNull();

    // HoursApproved must land reliably in volunteering.domain_events —
    // exactly the ADR-0015 integration-coverage requirement this path
    // needs (Phase 3's own completion bar names this event by name).
    const events = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "HourEntry", aggregateId: hourEntryId, eventType: "HoursApproved" },
    });
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      hourEntryId,
      personId: volunteer.id,
      opportunityId: opportunity.id,
      chapterId: opportunity.chapterId,
      approverPersonId: lead.id,
    });
  });

  it("negative test: once approved, no code path can mutate the row — a second approve/reject attempt fails", async () => {
    const { lead, volunteer, opportunity } = await setup();
    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId: opportunity.id,
      shiftId: null,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      description: null,
    });
    await approveHours(prisma, { caller: callerSubject(lead), hourEntryId });

    // Application layer refuses (precondition: status must be 'submitted').
    await expect(approveHours(prisma, { caller: callerSubject(lead), hourEntryId })).rejects.toThrow(
      HourEntryNotSubmittedError,
    );
    await expect(
      rejectHours(prisma, { caller: callerSubject(lead), hourEntryId, rejectionReason: "changed my mind" }),
    ).rejects.toThrow(HourEntryNotSubmittedError);

    // Database trigger backstop (`trg_hour_entries_immutable`): even a raw
    // UPDATE bypassing this module's own code entirely is rejected.
    await expect(
      prisma.$executeRaw`UPDATE volunteering.hour_entries SET description = 'tampered' WHERE id = ${hourEntryId}`,
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

    const row = await prisma.hourEntry.findUniqueOrThrow({ where: { id: hourEntryId } });
    expect(row.description).toBeNull();
    expect(row.status).toBe("approved");
  });

  it("rejects with a reason recorded, emitting HoursRejected", async () => {
    const { lead, volunteer, opportunity } = await setup();
    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId: opportunity.id,
      shiftId: null,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      description: null,
    });

    await rejectHours(prisma, { caller: callerSubject(lead), hourEntryId, rejectionReason: "No supporting details." });

    const row = await prisma.hourEntry.findUniqueOrThrow({ where: { id: hourEntryId } });
    expect(row.status).toBe("rejected");
    expect(row.rejectionReason).toBe("No supporting details.");

    const events = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "HourEntry", aggregateId: hourEntryId, eventType: "HoursRejected" },
    });
    expect(events).toHaveLength(1);
  });

  it("requires a non-empty rejectionReason", async () => {
    const { lead, volunteer, opportunity } = await setup();
    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId: opportunity.id,
      shiftId: null,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      description: null,
    });

    await expect(
      rejectHours(prisma, { caller: callerSubject(lead), hourEntryId, rejectionReason: "   " }),
    ).rejects.toThrow(RejectionReasonRequiredError);
  });

  it("forbids self-approval", async () => {
    const { volunteer, opportunity } = await setup();
    await grantRoleDirect(prisma, {
      subjectId: volunteer.id,
      role: "org_admin",
      grantedBy: volunteer.id,
    });
    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId: opportunity.id,
      shiftId: null,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      description: null,
    });

    await expect(
      approveHours(prisma, { caller: callerSubject(volunteer), hourEntryId }),
    ).rejects.toThrow(SelfApprovalNotAllowedError);
  });

  it("denies approval for a caller without chapter-scoped authority", async () => {
    const { volunteer, opportunity } = await setup();
    const rando = track(personIds, await createPerson(prisma, { displayName: "Rando" }));
    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId: opportunity.id,
      shiftId: null,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      description: null,
    });

    await expect(approveHours(prisma, { caller: callerSubject(rando), hourEntryId })).rejects.toThrow(
      ForbiddenActionError,
    );
  });
});
