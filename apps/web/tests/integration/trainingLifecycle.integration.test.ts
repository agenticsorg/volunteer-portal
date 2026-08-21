import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCourse,
  addModule,
  initiateVideoUpload,
  ingestVideoWebhook,
  approveCaptions,
  publishCourse,
  enrollInCourse,
  recordProgress,
  submitQuizAttempt,
  getVideoPlaybackUrl,
  getMyEnrollment,
  searchTraining,
  listCertificatesForPerson,
  CourseNotPublishableError,
  NotEnrolledError,
} from "@/modules/training";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject } from "./helpers/volunteeringFixtures";
import {
  fakeStreamAdapter,
  fakeR2Adapter,
  readyWebhookBody,
  processingWebhookBody,
  errorWebhookBody,
} from "./helpers/trainingFixtures";

// Exercises the Course/Module/Video/Enrollment/Quiz/Certificate lifecycle
// end to end against a real Postgres: authoring -> the mandatory
// caption-approval publish gate (Phase 4 completion bar: "a course cannot
// be published while any module's video is caption-unapproved" — a
// negative test) -> enrollment -> watch-progress + quiz-gated module
// completion -> course completion -> certificate issuance to R2 (Phase 4
// completion bar: "completing all modules and passing required quizzes
// issues a certificate to R2 and emits CourseCompleted") -> full-text
// search across course/module/video (Phase 4 completion bar: "training
// content is searchable via the tsvector column").
describe("Training lifecycle (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const courseIds: string[] = [];
  const enrollmentIds: string[] = [];

  afterAll(async () => {
    // Scoped cleanup, same "never an unscoped deleteMany" discipline as
    // opportunities.integration.test.ts — other integration files run
    // against the same shared testcontainer Postgres in parallel.
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

  async function setupContentAdmin() {
    const admin = await createPerson(prisma, { displayName: "Content Admin" });
    personIds.push(admin.id);
    await grantRoleDirect(prisma, {
      subjectId: admin.id,
      role: "content_admin",
      scopeType: "global",
      grantedBy: admin.id,
    });
    return admin;
  }

  async function addPublishedVideoModule(
    admin: { id: string; status: string },
    courseId: string,
    args: {
      title: string;
      sequence: number;
      quiz?: Parameters<typeof addModule>[1]["quiz"];
      transcriptText?: string;
    },
  ) {
    const stream = fakeStreamAdapter();
    const { moduleId, quizId } = await addModule(prisma, {
      caller: callerSubject(admin),
      courseId,
      title: args.title,
      sequence: args.sequence,
      quiz: args.quiz,
    });
    const { videoId, uploadUrl } = await initiateVideoUpload(
      prisma,
      { caller: callerSubject(admin), moduleId },
      stream,
    );
    expect(uploadUrl).toMatch(/^https:\/\//);

    const videoRow = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    await ingestVideoWebhook(
      prisma,
      { rawBody: readyWebhookBody(videoRow.cloudflareStreamId), signatureHeader: "time=1,sig1=deadbeef" },
      stream,
    );

    let video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodeStatus).toBe("ready");
    expect(video.captionStatus).toBe("auto_generated");

    await approveCaptions(prisma, {
      caller: callerSubject(admin),
      videoId,
      transcriptText: args.transcriptText ?? `Transcript for ${args.title}.`,
    });

    video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.captionStatus).toBe("approved");

    return { moduleId, videoId, quizId };
  }

  it("hard-fails PublishCourse while any module's video captions are unapproved, then publishes once approved", async () => {
    const admin = await setupContentAdmin();
    const { courseId } = await createCourse(prisma, {
      caller: callerSubject(admin),
      slug: `gate-test-${Date.now()}`,
      title: "Publish Gate Test Course",
    });
    courseIds.push(courseId);

    const { moduleId } = await addModule(prisma, {
      caller: callerSubject(admin),
      courseId,
      title: "Module 1",
      sequence: 1,
    });

    // No video at all yet — zero-approved-video state.
    await expect(publishCourse(prisma, { caller: callerSubject(admin), courseId })).rejects.toBeInstanceOf(
      CourseNotPublishableError,
    );

    const stream = fakeStreamAdapter();
    const { videoId } = await initiateVideoUpload(prisma, { caller: callerSubject(admin), moduleId }, stream);
    const videoRow = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    await ingestVideoWebhook(
      prisma,
      { rawBody: readyWebhookBody(videoRow.cloudflareStreamId), signatureHeader: "time=1,sig1=x" },
      stream,
    );

    // Ready + auto_generated captions — still not approved. Negative test:
    // this is the literal proof no code path bypasses the caption gate.
    await expect(publishCourse(prisma, { caller: callerSubject(admin), courseId })).rejects.toBeInstanceOf(
      CourseNotPublishableError,
    );

    await approveCaptions(prisma, { caller: callerSubject(admin), videoId, transcriptText: "Approved transcript." });

    const published = await publishCourse(prisma, { caller: callerSubject(admin), courseId });
    expect(published.status).toBe("published");

    const row = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });
    expect(row.status).toBe("published");
  });

  it("advances Video.encodeStatus from uploading through processing to error on a later failed-encode webhook", async () => {
    const admin = await setupContentAdmin();
    const { courseId } = await createCourse(prisma, {
      caller: callerSubject(admin),
      slug: `encode-error-test-${Date.now()}`,
      title: "Encode Error Test Course",
    });
    courseIds.push(courseId);

    const { moduleId } = await addModule(prisma, {
      caller: callerSubject(admin),
      courseId,
      title: "Module 1",
      sequence: 1,
    });

    const stream = fakeStreamAdapter();
    const { videoId } = await initiateVideoUpload(prisma, { caller: callerSubject(admin), moduleId }, stream);
    const videoRow = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(videoRow.encodeStatus).toBe("uploading");

    // uploading -> processing (an intermediate `inprogress` delivery).
    await ingestVideoWebhook(
      prisma,
      { rawBody: processingWebhookBody(videoRow.cloudflareStreamId), signatureHeader: "time=1,sig1=x" },
      stream,
    );
    let video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodeStatus).toBe("processing");

    // processing -> error (a later failed-encode delivery must still land,
    // not be silently dropped because the row already moved off `uploading`).
    await ingestVideoWebhook(
      prisma,
      { rawBody: errorWebhookBody(videoRow.cloudflareStreamId), signatureHeader: "time=1,sig1=x" },
      stream,
    );
    video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodeStatus).toBe("error");

    // error is terminal — a stray redelivery reporting `processing` again must not resurrect it.
    await ingestVideoWebhook(
      prisma,
      { rawBody: processingWebhookBody(videoRow.cloudflareStreamId), signatureHeader: "time=1,sig1=x" },
      stream,
    );
    video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodeStatus).toBe("error");
  });

  it(
    "completes modules (watch-progress + quiz gating), completes the course, issues a certificate to R2, " +
      "and emits CourseCompleted",
    async () => {
      const admin = await setupContentAdmin();
      const learner = await createPerson(prisma, { displayName: "Eager Learner" });
      personIds.push(learner.id);

      const { courseId } = await createCourse(prisma, {
        caller: callerSubject(admin),
        slug: `completion-test-${Date.now()}`,
        title: "Safety Onboarding",
        description: "Required safety training for new volunteers.",
      });
      courseIds.push(courseId);

      // transcriptText deliberately contains a word ("Glockenspiel")
      // absent from every course/module title in this test, so a search
      // hit on it can only come from `training.video.search_vector`
      // (generated solely from `transcript_text`, per the
      // `add_training_aggregates` migration) — not from title matching.
      const moduleA = await addPublishedVideoModule(admin, courseId, {
        title: "Intro",
        sequence: 1,
        transcriptText: "In this module we cover the safety glockenspiel demonstration.",
      });
      const moduleB = await addPublishedVideoModule(admin, courseId, {
        title: "Safety Quiz Module",
        sequence: 2,
        quiz: {
          passingScorePercent: 80,
          questions: [
            {
              prompt: "What do you do in an emergency?",
              choices: [
                { label: "Call for help", isCorrect: true },
                { label: "Ignore it", isCorrect: false },
              ],
            },
          ],
        },
      });

      await publishCourse(prisma, { caller: callerSubject(admin), courseId });

      const { enrollmentId } = await enrollInCourse(prisma, { personId: learner.id, courseId });
      enrollmentIds.push(enrollmentId);

      // Playback is gated by BOTH enrollment and can() — a real, enrolled
      // learner gets a signed URL.
      const playback = await getVideoPlaybackUrl(
        prisma,
        { caller: callerSubject(learner), videoId: moduleA.videoId },
        fakeStreamAdapter(),
      );
      expect(playback.url).toContain(learner.id);

      // A non-enrolled stranger is denied even with a valid videoId.
      const stranger = await createPerson(prisma, { displayName: "Stranger" });
      personIds.push(stranger.id);
      await expect(
        getVideoPlaybackUrl(prisma, { caller: callerSubject(stranger), videoId: moduleA.videoId }, fakeStreamAdapter()),
      ).rejects.toBeInstanceOf(NotEnrolledError);

      // Module A (no quiz): crossing 90% watch progress completes it immediately.
      const progressA = await recordProgress(prisma, {
        personId: learner.id,
        enrollmentId,
        moduleId: moduleA.moduleId,
        resumePositionSeconds: 110,
        watchProgressPercent: 95,
      });
      expect(progressA.moduleStatus).toBe("completed");
      expect(progressA.courseCompleted).toBe(false); // module B still untouched

      // Module B (has a quiz): 95% watch alone does NOT complete it.
      const progressB = await recordProgress(prisma, {
        personId: learner.id,
        enrollmentId,
        moduleId: moduleB.moduleId,
        resumePositionSeconds: 110,
        watchProgressPercent: 95,
      });
      expect(progressB.moduleStatus).toBe("in_progress");
      expect(progressB.courseCompleted).toBe(false);

      // A failed quiz attempt does not complete the module.
      const questions = await prisma.quizQuestion.findMany({
        where: { quizId: moduleB.quizId! },
        include: { choices: true },
      });
      const wrongAnswers = questions.map((q) => ({
        questionId: q.id,
        choiceId: q.choices.find((c) => !c.isCorrect)!.id,
      }));
      const failedAttempt = await submitQuizAttempt(prisma, {
        personId: learner.id,
        enrollmentId,
        quizId: moduleB.quizId!,
        answers: wrongAnswers,
      });
      expect(failedAttempt.passed).toBe(false);
      expect(failedAttempt.moduleStatus).toBe("in_progress");

      // A passing quiz attempt completes module B, which completes the
      // course (both required modules done) and issues a certificate to
      // R2 via the injected fake adapter.
      const correctAnswers = questions.map((q) => ({
        questionId: q.id,
        choiceId: q.choices.find((c) => c.isCorrect)!.id,
      }));
      const passedAttempt = await submitQuizAttempt(
        prisma,
        { personId: learner.id, enrollmentId, quizId: moduleB.quizId!, answers: correctAnswers },
        fakeR2Adapter(),
      );
      expect(passedAttempt.passed).toBe(true);
      expect(passedAttempt.moduleStatus).toBe("completed");
      expect(passedAttempt.courseCompleted).toBe(true);

      const enrollmentRow = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
      expect(enrollmentRow.status).toBe("completed");
      expect(enrollmentRow.completedAt).not.toBeNull();

      const courseCompletedEvent = await prisma.trainingDomainEvent.findFirst({
        where: { aggregateId: enrollmentId, eventType: "CourseCompleted" },
      });
      expect(courseCompletedEvent).not.toBeNull();

      const certificateEvent = await prisma.trainingDomainEvent.findFirst({
        where: { eventType: "CertificateIssued", payload: { path: ["courseId"], equals: courseId } },
      });
      expect(certificateEvent).not.toBeNull();

      const certificates = await listCertificatesForPerson(prisma, learner.id);
      const certificate = certificates.find((c) => c.courseId === courseId);
      expect(certificate).toBeDefined();
      expect(certificate!.pdfFileKey).toBe(`certificates/${learner.id}/${certificate!.certificateId}.pdf`);

      const enrollmentSummary = await getMyEnrollment(prisma, learner.id, courseId);
      expect(enrollmentSummary?.status).toBe("completed");
      expect(enrollmentSummary?.moduleProgress.every((m) => m.status === "completed")).toBe(true);

      // ADR-0017 full-text search across course/module/video.
      const courseHits = await searchTraining(prisma, { query: "Safety" });
      expect(courseHits.some((r) => r.kind === "course" && r.courseId === courseId)).toBe(true);
      expect(courseHits.some((r) => r.kind === "module" && r.courseId === courseId)).toBe(true);
      // A transcript-only term proves `training.video`'s tsvector column
      // (built solely from transcript_text, never title) is genuinely
      // searchable — not merely a coincidental match against a
      // course/module title (Phase 4 completion bar: "training content is
      // searchable via the tsvector column").
      const transcriptHits = await searchTraining(prisma, { query: "glockenspiel" });
      expect(
        transcriptHits.some((r) => r.kind === "video" && r.courseId === courseId),
      ).toBe(true);
    },
  );
});
