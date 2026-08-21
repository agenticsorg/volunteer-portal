import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { decideApplication } from "@/modules/volunteering";
import {
  createCourse,
  addModule,
  initiateVideoUpload,
  ingestVideoWebhook,
  approveCaptions,
  publishCourse,
  enrollInCourse,
  recordProgress,
  hasCompletedRequiredCourses,
} from "@/modules/training";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject, createOpportunityDirect, createShiftDirect, createApplicationDirect } from "./helpers/volunteeringFixtures";
import { fakeStreamAdapter, readyWebhookBody } from "./helpers/trainingFixtures";

// Phase 4 completion bar's specific regression proof: "an Opportunity with
// prerequisiteCourseIds set now actually blocks an ineligible applicant and
// allows an eligible one — this specific regression test is the proof that
// the Phase 3 `hasCompletedRequiredTraining` stub was correctly replaced,
// not just that Training works in isolation."
describe("Volunteering <-> Training: prerequisite gating (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const courseIds: string[] = [];
  const enrollmentIds: string[] = [];
  const opportunityIds: string[] = [];

  afterAll(async () => {
    await prisma.trainingDomainEvent.deleteMany({ where: { aggregateId: { in: [...courseIds, ...enrollmentIds] } } });
    await prisma.certificate.deleteMany({ where: { enrollmentId: { in: enrollmentIds } } });
    await prisma.enrollment.deleteMany({ where: { id: { in: enrollmentIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.volunteeringDomainEvent.deleteMany({ where: { aggregateId: { in: opportunityIds } } });
    await prisma.application.deleteMany({ where: { shift: { opportunityId: { in: opportunityIds } } } });
    await prisma.shift.deleteMany({ where: { opportunityId: { in: opportunityIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function publishSimpleCourse(admin: { id: string; status: string }, title: string) {
    const { courseId } = await createCourse(prisma, {
      caller: callerSubject(admin),
      slug: `prereq-${title.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
      title,
    });
    courseIds.push(courseId);

    const stream = fakeStreamAdapter();
    const { moduleId } = await addModule(prisma, { caller: callerSubject(admin), courseId, title: "Only Module", sequence: 1 });
    const { videoId } = await initiateVideoUpload(prisma, { caller: callerSubject(admin), moduleId }, stream);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    await ingestVideoWebhook(
      prisma,
      { rawBody: readyWebhookBody(video.cloudflareStreamId), signatureHeader: "time=1,sig1=x" },
      stream,
    );
    await approveCaptions(prisma, { caller: callerSubject(admin), videoId, transcriptText: "Transcript." });
    await publishCourse(prisma, { caller: callerSubject(admin), courseId });

    return { courseId, moduleId };
  }

  it("blocks an ineligible applicant and allows an eligible one, based on the real training completion state", async () => {
    const orgAdmin = await createPerson(prisma, { displayName: "Org Admin" });
    personIds.push(orgAdmin.id);
    await grantRoleDirect(prisma, { subjectId: orgAdmin.id, role: "org_admin", scopeType: "global", grantedBy: orgAdmin.id });

    const contentAdmin = await createPerson(prisma, { displayName: "Content Admin" });
    personIds.push(contentAdmin.id);
    await grantRoleDirect(prisma, {
      subjectId: contentAdmin.id,
      role: "content_admin",
      scopeType: "global",
      grantedBy: contentAdmin.id,
    });

    const { courseId, moduleId } = await publishSimpleCourse(contentAdmin, "Required Safety Training");

    const opportunity = await createOpportunityDirect(prisma, {
      chapterId: null,
      status: "published",
      createdByPersonId: orgAdmin.id,
      prerequisiteCourseIds: [courseId],
    });
    opportunityIds.push(opportunity.id);
    const shift = await createShiftDirect(prisma, { opportunityId: opportunity.id, capacity: 5 });

    const ineligibleApplicant = await createPerson(prisma, { displayName: "Ineligible Applicant" });
    personIds.push(ineligibleApplicant.id);
    const ineligibleApplication = await createApplicationDirect(prisma, {
      shiftId: shift.id,
      applicantPersonId: ineligibleApplicant.id,
    });

    const eligibleApplicant = await createPerson(prisma, { displayName: "Eligible Applicant" });
    personIds.push(eligibleApplicant.id);
    const eligibleApplication = await createApplicationDirect(prisma, {
      shiftId: shift.id,
      applicantPersonId: eligibleApplicant.id,
    });

    // Ineligible applicant has never enrolled in the prerequisite course —
    // `decideApplication`'s "accept" request is silently forced to
    // "waitlisted" (DecideApplication invariant 5's documented behavior,
    // not an error).
    const ineligibleOutcome = await decideApplication(prisma, {
      caller: callerSubject(orgAdmin),
      applicationId: ineligibleApplication.id,
      decision: "accept",
    });
    expect(ineligibleOutcome.outcome).toBe("waitlisted");

    // The eligible applicant completes the prerequisite course for real.
    const { enrollmentId } = await enrollInCourse(prisma, { personId: eligibleApplicant.id, courseId });
    enrollmentIds.push(enrollmentId);
    const progress = await recordProgress(prisma, {
      personId: eligibleApplicant.id,
      enrollmentId,
      moduleId,
      resumePositionSeconds: 100,
      watchProgressPercent: 100,
    });
    expect(progress.moduleStatus).toBe("completed");
    expect(progress.courseCompleted).toBe(true);

    expect(await hasCompletedRequiredCourses(prisma, eligibleApplicant.id, [courseId])).toBe(true);
    expect(await hasCompletedRequiredCourses(prisma, ineligibleApplicant.id, [courseId])).toBe(false);

    const eligibleOutcome = await decideApplication(prisma, {
      caller: callerSubject(orgAdmin),
      applicationId: eligibleApplication.id,
      decision: "accept",
    });
    expect(eligibleOutcome.outcome).toBe("accepted");
  });

  it("hasCompletedRequiredCourses is vacuously true when the opportunity has no prerequisites", async () => {
    const person = await createPerson(prisma, { displayName: "No Prereqs" });
    personIds.push(person.id);
    expect(await hasCompletedRequiredCourses(prisma, person.id, [])).toBe(true);
  });
});
