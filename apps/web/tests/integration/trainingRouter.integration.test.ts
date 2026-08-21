import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { createCallerFactory } from "@/server/api/trpc";
import { trainingRouter } from "@/server/api/routers/training";
import { createPerson, grantRoleDirect, contextFor } from "./helpers/identityFixtures";
import {
  createCourseDirect,
  createModuleWithReadyVideoDirect,
  createQuizDirect,
  createEnrollmentDirect,
  createCertificateDirect,
} from "./helpers/trainingFixtures";
import { POST as webhookRoute } from "@/app/api/v1/webhooks/cloudflare-stream/route";
import { GET as coursesRoute } from "@/app/api/v1/courses/route";
import { GET as verifyCertificateRoute } from "@/app/api/v1/certificates/[certificateId]/verify/route";

// Exercises the training tRPC router built this stage
// (docs/ddd/training-learning.md's API Contract Sketch) end to end
// against a real Postgres: input validation, the `can()`-gated authoring
// use cases' authorization (via `assertTrainingAuthority`), the router's
// own certificate-ownership check, TRPCError code translation, ADR-0017
// full-text search, and the REST surfaces (Cloudflare Stream webhook,
// public course catalog, public certificate verification) — via a direct
// (non-HTTP) caller (`createCallerFactory`) and real `NextRequest`s for
// the route handlers, same shape as `volunteeringRouter.integration.test.ts`.
describe("trainingRouter (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(trainingRouter);
  const personIds: string[] = [];
  const courseIds: string[] = [];
  const enrollmentIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.trainingDomainEvent.deleteMany({
      where: { aggregateId: { in: [...courseIds, ...enrollmentIds] } },
    });
    await prisma.certificate.deleteMany({ where: { enrollmentId: { in: enrollmentIds } } });
    await prisma.enrollment.deleteMany({ where: { id: { in: enrollmentIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } }); // cascades module/video/quiz/prerequisite
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function makeContentAdmin() {
    const admin = await createPerson(prisma, { displayName: "Content Admin" });
    track(admin.id);
    await grantRoleDirect(prisma, { subjectId: admin.id, role: "content_admin", scopeType: "global", grantedBy: admin.id });
    return admin;
  }

  function callerFor(person: { id: string; publicSlug: string; displayName: string; avatarUrl: string | null; status: string }) {
    return createCaller(contextFor(prisma, person));
  }

  describe("courses / modules (authoring)", () => {
    it("createCourse requires course.manage authority; a plain volunteer is denied", async () => {
      const volunteer = track((await createPerson(prisma)).id);
      const volunteerPerson = await prisma.person.findUniqueOrThrow({ where: { id: volunteer } });

      await expect(
        callerFor(volunteerPerson).createCourse({ slug: `denied-${Date.now()}`, title: "Denied Course" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("createCourse -> addModule -> publishCourse (with an approved video) round-trips through the router", async () => {
      const admin = await makeContentAdmin();
      const created = await callerFor(admin).createCourse({
        slug: `router-course-${Date.now()}`,
        title: "Router Test Course",
        description: "Created via the tRPC router.",
      });
      courseIds.push(created.courseId);
      expect(created.courseId).toBeTruthy();

      const addedModule = await callerFor(admin).addModule({
        courseId: created.courseId,
        title: "Module One",
        sequence: 1,
      });
      expect(addedModule.moduleId).toBeTruthy();

      // No video yet — PublishCourse must hard-fail (Phase 4 negative test,
      // exercised through the router's own error mapping).
      await expect(callerFor(admin).publishCourse({ courseId: created.courseId })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });

      // Attach a ready+approved video directly (bypassing Cloudflare) so
      // the router-level publish path can be exercised without live
      // credentials — the caption-approval gate itself is already proven
      // end to end in trainingLifecycle.integration.test.ts.
      await prisma.video.create({
        data: {
          id: newId(),
          moduleId: addedModule.moduleId,
          cloudflareStreamId: newId(),
          encodeStatus: "ready",
          captionStatus: "approved",
          transcriptText: "Router test transcript.",
        },
      });

      const published = await callerFor(admin).publishCourse({ courseId: created.courseId });
      expect(published.status).toBe("published");

      const catalog = await callerFor(admin).getCourseCatalog({ status: "published" });
      expect(catalog.some((c) => c.courseId === created.courseId)).toBe(true);

      const detail = await callerFor(admin).getCourseById({ courseId: created.courseId });
      expect(detail.modules).toHaveLength(1);
      expect(detail.modules[0]?.video?.captionStatus).toBe("approved");
    });

    it("initiateVideoUpload surfaces the missing-Cloudflare-credential error as INTERNAL_SERVER_ERROR (no live credentials in this environment)", async () => {
      const admin = await makeContentAdmin();
      const created = await callerFor(admin).createCourse({ slug: `no-cf-${Date.now()}`, title: "No Cloudflare Course" });
      courseIds.push(created.courseId);
      const addedModule = await callerFor(admin).addModule({ courseId: created.courseId, title: "M1", sequence: 1 });

      await expect(callerFor(admin).initiateVideoUpload({ moduleId: addedModule.moduleId })).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: expect.stringContaining("CLOUDFLARE"),
      });
    });
  });

  describe("enrollment / progress / quizzes (learner-facing)", () => {
    async function publishedCourseWithQuizModule() {
      const admin = await makeContentAdmin();
      const course = await createCourseDirect(prisma, { status: "published", createdByPersonId: admin.id });
      courseIds.push(course.id);
      const { moduleId } = await createModuleWithReadyVideoDirect(prisma, { courseId: course.id, sequence: 1 });
      const quiz = await createQuizDirect(prisma, { moduleId, passingScorePercent: 100 });
      return { course, moduleId, quiz };
    }

    it("enrollInCourse seeds ModuleProgress, then recordProgress + submitQuizAttempt complete the module and course, and getMyEnrollment reflects it", async () => {
      const { course, moduleId, quiz } = await publishedCourseWithQuizModule();
      const learner = track((await createPerson(prisma, { displayName: "Learner" })).id);
      const learnerPerson = await prisma.person.findUniqueOrThrow({ where: { id: learner } });

      const enrolled = await callerFor(learnerPerson).enrollInCourse({ courseId: course.id });
      enrollmentIds.push(enrolled.enrollmentId);

      const beforeProgress = await callerFor(learnerPerson).getMyEnrollment({ courseId: course.id });
      expect(beforeProgress?.moduleProgress).toHaveLength(1);
      expect(beforeProgress?.moduleProgress[0]?.status).toBe("not_started");

      const progressResult = await callerFor(learnerPerson).recordProgress({
        enrollmentId: enrolled.enrollmentId,
        moduleId,
        resumePositionSeconds: 95,
        watchProgressPercent: 95,
      });
      // Watch progress alone doesn't complete a module with an attached
      // (unpassed) quiz — Module invariant 1.
      expect(progressResult.moduleStatus).toBe("in_progress");

      const attempt = await callerFor(learnerPerson).submitQuizAttempt({
        enrollmentId: enrolled.enrollmentId,
        quizId: quiz.quizId,
        answers: [{ questionId: quiz.questionId, choiceId: quiz.correctChoiceId }],
      });
      expect(attempt.passed).toBe(true);
      expect(attempt.moduleStatus).toBe("completed");
      expect(attempt.courseCompleted).toBe(true);

      const afterProgress = await callerFor(learnerPerson).getMyEnrollment({ courseId: course.id });
      expect(afterProgress?.status).toBe("completed");
      expect(afterProgress?.moduleProgress[0]?.status).toBe("completed");
    });

    it("recordProgress rejects a caller with no enrollment (NOT_FOUND on a bogus enrollmentId)", async () => {
      const { moduleId } = await publishedCourseWithQuizModule();
      const learner = track((await createPerson(prisma)).id);
      const learnerPerson = await prisma.person.findUniqueOrThrow({ where: { id: learner } });

      await expect(
        callerFor(learnerPerson).recordProgress({
          enrollmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          moduleId,
          resumePositionSeconds: 0,
          watchProgressPercent: 10,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("submitQuizAttempt with a wrong answer fails and does not complete the module", async () => {
      const { course, moduleId, quiz } = await publishedCourseWithQuizModule();
      const learner = track((await createPerson(prisma)).id);
      const learnerPerson = await prisma.person.findUniqueOrThrow({ where: { id: learner } });

      const enrolled = await callerFor(learnerPerson).enrollInCourse({ courseId: course.id });
      enrollmentIds.push(enrolled.enrollmentId);

      await callerFor(learnerPerson).recordProgress({
        enrollmentId: enrolled.enrollmentId,
        moduleId,
        resumePositionSeconds: 100,
        watchProgressPercent: 100,
      });

      const attempt = await callerFor(learnerPerson).submitQuizAttempt({
        enrollmentId: enrolled.enrollmentId,
        quizId: quiz.quizId,
        answers: [{ questionId: quiz.questionId, choiceId: quiz.wrongChoiceId }],
      });
      expect(attempt.passed).toBe(false);
      expect(attempt.moduleStatus).not.toBe("completed");
    });
  });

  describe("search (ADR-0017)", () => {
    it("finds a published course by title via the tsvector column", async () => {
      const admin = await makeContentAdmin();
      const uniqueTitle = `Zephyr Wildlife Rescue Basics ${Date.now()}`;
      const course = await createCourseDirect(prisma, {
        status: "published",
        title: uniqueTitle,
        createdByPersonId: admin.id,
      });
      courseIds.push(course.id);

      const results = await callerFor(admin).search({ query: "Zephyr Wildlife Rescue" });
      expect(results.some((r) => r.courseId === course.id)).toBe(true);
    });
  });

  describe("certificates", () => {
    it("getCertificate: the holder may read their own certificate; a stranger is FORBIDDEN; an admin may read any", async () => {
      const admin = await makeContentAdmin();
      const holder = track((await createPerson(prisma)).id);
      const holderPerson = await prisma.person.findUniqueOrThrow({ where: { id: holder } });
      const stranger = track((await createPerson(prisma)).id);
      const strangerPerson = await prisma.person.findUniqueOrThrow({ where: { id: stranger } });

      const course = await createCourseDirect(prisma, { status: "published", createdByPersonId: admin.id });
      courseIds.push(course.id);
      const { enrollmentId } = await createEnrollmentDirect(prisma, { personId: holder, courseId: course.id, moduleIds: [], status: "completed" });
      enrollmentIds.push(enrollmentId);
      const certificate = await createCertificateDirect(prisma, { personId: holder, courseId: course.id, enrollmentId });

      const own = await callerFor(holderPerson).getCertificate({ certificateId: certificate.id });
      expect(own.certificateId).toBe(certificate.id);

      await expect(callerFor(strangerPerson).getCertificate({ certificateId: certificate.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const asAdmin = await callerFor(admin).getCertificate({ certificateId: certificate.id });
      expect(asAdmin.certificateId).toBe(certificate.id);

      const mine = await callerFor(holderPerson).listMyCertificates();
      expect(mine.map((c) => c.certificateId)).toContain(certificate.id);
    });
  });

  describe("REST: POST /api/v1/webhooks/cloudflare-stream", () => {
    it("returns 500 (not 200) when CLOUDFLARE_STREAM_WEBHOOK_SECRET is unset in this environment, rather than faking success", async () => {
      const request = new NextRequest("https://example.test/api/v1/webhooks/cloudflare-stream", {
        method: "POST",
        headers: { "webhook-signature": "time=1,sig1=deadbeef" },
        body: JSON.stringify({ uid: "unknown-uid", status: { state: "ready" }, readyToStream: true }),
      });
      const response = await webhookRoute(request);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("CLOUDFLARE_STREAM_WEBHOOK_SECRET");
    });
  });

  describe("REST: GET /api/v1/courses", () => {
    it("returns only published courses, unauthenticated", async () => {
      const admin = await makeContentAdmin();
      const published = await createCourseDirect(prisma, { status: "published", title: "REST Catalog Course", createdByPersonId: admin.id });
      const draft = await createCourseDirect(prisma, { status: "draft", title: "REST Draft Course", createdByPersonId: admin.id });
      courseIds.push(published.id, draft.id);

      const response = await coursesRoute();
      const body = await response.json();
      const ids = body.courses.map((c: { courseId: string }) => c.courseId);
      expect(ids).toContain(published.id);
      expect(ids).not.toContain(draft.id);
    });
  });

  describe("REST: GET /api/v1/certificates/:certificateId/verify", () => {
    it("returns public verification data for a real certificate, and 404 for an unknown one", async () => {
      const admin = await makeContentAdmin();
      const holder = track((await createPerson(prisma, { displayName: "Verify Me" })).id);
      const course = await createCourseDirect(prisma, { status: "published", title: "Verifiable Course", createdByPersonId: admin.id });
      courseIds.push(course.id);
      const { enrollmentId } = await createEnrollmentDirect(prisma, { personId: holder, courseId: course.id, moduleIds: [], status: "completed" });
      enrollmentIds.push(enrollmentId);
      const certificate = await createCertificateDirect(prisma, { personId: holder, courseId: course.id, enrollmentId });

      const found = await verifyCertificateRoute(new NextRequest("https://example.test/x"), {
        params: Promise.resolve({ certificateId: certificate.id }),
      });
      expect(found.status).toBe(200);
      const body = await found.json();
      expect(body.valid).toBe(true);
      expect(body.certificateNumber).toBe(certificate.certificateNumber);
      expect(body.courseTitle).toBe("Verifiable Course");
      expect(body.recipientDisplayName).toBe("Verify Me");
      expect(body.personId).toBeUndefined();

      const notFound = await verifyCertificateRoute(new NextRequest("https://example.test/x"), {
        params: Promise.resolve({ certificateId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      });
      expect(notFound.status).toBe(404);
    });
  });
});
