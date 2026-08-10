import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  assignChapterLead,
  ChapterSlugTakenError,
  createChapter,
  ForbiddenActionError,
  NotAnActiveChapterLeadError,
} from "@/modules/identity";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";

// Exercises CreateChapter/AssignChapterLead (Key Use Cases 8-9): only
// org_admin may create a chapter or reassign its lead, and the lead
// pointer may only ever point at a Person holding an active chapter_lead
// assignment scoped to that exact chapter (Chapter invariant 2).
describe("createChapter / assignChapterLead (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const trackPerson = (id: string) => (personIds.push(id), id);
  const trackChapter = (id: string) => (chapterIds.push(id), id);

  afterAll(async () => {
    await prisma.identityDomainEvent.deleteMany({
      where: { OR: [{ aggregateId: { in: personIds } }, { aggregateId: { in: chapterIds } }] },
    });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  it("an org_admin can create a chapter, emitting ChapterCreated", async () => {
    const admin = trackPerson((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    const { chapterId } = await createChapter(prisma, {
      callerId: admin,
      name: "Agentics London",
      slug: `agentics-london-${admin.toLowerCase()}`,
      city: "London",
      region: null,
      country: "United Kingdom",
      foundedAt: null,
    });
    trackChapter(chapterId);

    const row = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } });
    expect(row).toMatchObject({ name: "Agentics London", status: "active" });

    const events = await prisma.identityDomainEvent.findMany({
      where: { aggregateType: "Chapter", aggregateId: chapterId, eventType: "ChapterCreated" },
    });
    expect(events).toHaveLength(1);
  });

  it("a non-admin cannot create a chapter", async () => {
    const volunteer = trackPerson((await createPerson(prisma)).id);

    await expect(
      createChapter(prisma, {
        callerId: volunteer,
        name: "Rogue Chapter",
        slug: `rogue-${volunteer.toLowerCase()}`,
        city: "Nowhere",
        region: null,
        country: "Nowhere",
        foundedAt: null,
      }),
    ).rejects.toThrow(ForbiddenActionError);
  });

  it("rejects a duplicate slug", async () => {
    const admin = trackPerson((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
    const slug = `dup-slug-${admin.toLowerCase()}`;

    const first = await createChapter(prisma, {
      callerId: admin,
      name: "First",
      slug,
      city: "A",
      region: null,
      country: "A",
      foundedAt: null,
    });
    trackChapter(first.chapterId);

    await expect(
      createChapter(prisma, {
        callerId: admin,
        name: "Second",
        slug,
        city: "B",
        region: null,
        country: "B",
        foundedAt: null,
      }),
    ).rejects.toThrow(ChapterSlugTakenError);
  });

  it("assigns a chapter lead once the target holds an active chapter_lead assignment scoped to it", async () => {
    const admin = trackPerson((await createPerson(prisma)).id);
    const lead = trackPerson((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    const { chapterId } = await createChapter(prisma, {
      callerId: admin,
      name: "Agentics Toronto",
      slug: `agentics-toronto-${admin.toLowerCase()}`,
      city: "Toronto",
      region: null,
      country: "Canada",
      foundedAt: null,
    });
    trackChapter(chapterId);

    await grantRoleDirect(prisma, {
      subjectId: lead,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: chapterId,
      grantedBy: admin,
    });

    await assignChapterLead(prisma, { callerId: admin, chapterId, personId: lead });

    const row = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } });
    expect(row.leadPersonId).toBe(lead);
  });

  it("refuses to assign a lead who does not hold an active chapter_lead assignment scoped to that chapter", async () => {
    const admin = trackPerson((await createPerson(prisma)).id);
    const notALead = trackPerson((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    const { chapterId } = await createChapter(prisma, {
      callerId: admin,
      name: "Agentics Berlin",
      slug: `agentics-berlin-${admin.toLowerCase()}`,
      city: "Berlin",
      region: null,
      country: "Germany",
      foundedAt: null,
    });
    trackChapter(chapterId);

    await expect(
      assignChapterLead(prisma, { callerId: admin, chapterId, personId: notALead }),
    ).rejects.toThrow(NotAnActiveChapterLeadError);
  });
});
