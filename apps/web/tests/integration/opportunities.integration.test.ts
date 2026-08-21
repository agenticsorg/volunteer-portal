import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  createOpportunity,
  publishOpportunity,
  closeOpportunity,
  archiveOpportunity,
  searchOpportunities,
  queryApprovedHours,
  submitHours,
  approveHours,
  InvalidOpportunityTransitionError,
  OpportunityHasScheduledShiftsError,
} from "@/modules/volunteering";
import { createPerson, grantRoleDirect, createChapterDirect } from "./helpers/identityFixtures";
import { callerSubject, createShiftDirect } from "./helpers/volunteeringFixtures";

// Exercises the Opportunity state machine (draft -> published -> closed ->
// archived) end to end, plus the Phase 3 completion bar's "opportunity
// search returns relevant results via the tsvector column" criterion.
describe("Opportunity lifecycle + search (integration)", () => {
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
    await prisma.hourEntry.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.application.deleteMany({ where: { shift: { opportunityId: { in: opportunityIds } } } });
    await prisma.shift.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function setupLead() {
    const chapter = track(chapterIds, await createChapterDirect(prisma));
    const lead = track(personIds, await createPerson(prisma, { displayName: "Chapter Lead" }));
    await grantRoleDirect(prisma, {
      subjectId: lead.id,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: chapter.id,
      grantedBy: lead.id,
    });
    return { chapter, lead };
  }

  it("walks draft -> published -> closed -> archived, emitting OpportunityPublished once", async () => {
    const { chapter, lead } = await setupLead();

    const { opportunityId } = await createOpportunity(prisma, {
      caller: callerSubject(lead),
      chapterId: chapter.id,
      title: "Community Garden Cleanup",
      description: "Help tidy up the community garden.",
      category: "event-support",
      skillsRequired: ["gardening"],
      locationType: "in_person",
      minAge: 16,
      prerequisiteCourseIds: [],
    });
    track(opportunityIds, { id: opportunityId });

    let row = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    expect(row.status).toBe("draft");

    await publishOpportunity(prisma, { caller: callerSubject(lead), opportunityId });
    row = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    expect(row.status).toBe("published");
    expect(row.publishedAt).not.toBeNull();

    const publishEvents = await prisma.volunteeringDomainEvent.findMany({
      where: { aggregateType: "Opportunity", aggregateId: opportunityId, eventType: "OpportunityPublished" },
    });
    expect(publishEvents).toHaveLength(1);

    // Invariant 2: once published, status never returns to draft — no
    // transition back is exposed, and re-publishing an already-published
    // row is rejected outright.
    await expect(publishOpportunity(prisma, { caller: callerSubject(lead), opportunityId })).rejects.toThrow(
      InvalidOpportunityTransitionError,
    );

    await closeOpportunity(prisma, { caller: callerSubject(lead), opportunityId });
    row = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    expect(row.status).toBe("closed");
    expect(row.closedAt).not.toBeNull();

    await archiveOpportunity(prisma, { caller: callerSubject(lead), opportunityId });
    row = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    expect(row.status).toBe("archived");
  });

  it("invariant 4: cannot archive while a Shift is still scheduled", async () => {
    const { chapter, lead } = await setupLead();
    const { opportunityId } = await createOpportunity(prisma, {
      caller: callerSubject(lead),
      chapterId: chapter.id,
      title: "Blocked Archive Test",
      description: "desc",
      category: "event-support",
      skillsRequired: [],
      locationType: "remote",
      minAge: 16,
      prerequisiteCourseIds: [],
    });
    track(opportunityIds, { id: opportunityId });
    await publishOpportunity(prisma, { caller: callerSubject(lead), opportunityId });
    await createShiftDirect(prisma, { opportunityId, status: "scheduled" });

    await closeOpportunity(prisma, { caller: callerSubject(lead), opportunityId });

    await expect(archiveOpportunity(prisma, { caller: callerSubject(lead), opportunityId })).rejects.toThrow(
      OpportunityHasScheduledShiftsError,
    );
  });

  it("full-text search finds a published opportunity by a title word via the tsvector column", async () => {
    const { chapter, lead } = await setupLead();
    const { opportunityId } = await createOpportunity(prisma, {
      caller: callerSubject(lead),
      chapterId: chapter.id,
      title: "Riverside Cleanup Volunteers Needed",
      description: "Join us to clean up litter along the riverside trail.",
      category: "event-support",
      skillsRequired: ["outdoors"],
      locationType: "in_person",
      minAge: 16,
      prerequisiteCourseIds: [],
    });
    track(opportunityIds, { id: opportunityId });
    await publishOpportunity(prisma, { caller: callerSubject(lead), opportunityId });

    const results = await searchOpportunities(prisma, { query: "riverside cleanup" });
    expect(results.some((r) => r.opportunityId === opportunityId)).toBe(true);

    const noMatch = await searchOpportunities(prisma, { query: "zzz-no-such-term-zzz" });
    expect(noMatch.some((r) => r.opportunityId === opportunityId)).toBe(false);
  });

  it("queryApprovedHours returns only approved entries within the date range, with chapterId resolved via the same-schema Opportunity join", async () => {
    const { chapter, lead } = await setupLead();
    const volunteer = track(personIds, await createPerson(prisma, { displayName: "Volunteer" }));
    const { opportunityId } = await createOpportunity(prisma, {
      caller: callerSubject(lead),
      chapterId: chapter.id,
      title: "Grant Reporting Test Opportunity",
      description: "desc",
      category: "event-support",
      skillsRequired: [],
      locationType: "remote",
      minAge: 16,
      prerequisiteCourseIds: [],
    });
    track(opportunityIds, { id: opportunityId });
    await publishOpportunity(prisma, { caller: callerSubject(lead), opportunityId });

    const { hourEntryId } = await submitHours(prisma, {
      personId: volunteer.id,
      opportunityId,
      shiftId: null,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      description: null,
    });
    await approveHours(prisma, { caller: callerSubject(lead), hourEntryId });

    const results = await queryApprovedHours(prisma, {
      chapterId: chapter.id,
      fromDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      toDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(results.some((r) => r.hourEntryId === hourEntryId && r.chapterId === chapter.id)).toBe(true);
  });
});
