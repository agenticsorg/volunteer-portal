import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import type { CloudflareStreamAdapter, CertificateStorageAdapter } from "@/modules/training";

/**
 * Shared fixtures for the Phase 4 training-use-case integration suites.
 * No live Cloudflare credentials exist in this environment (per this
 * phase's own brief) — every integration test that needs a Cloudflare
 * Stream/R2 adapter injects one of these fakes instead of the real
 * `cloudflareStreamAdapter`/`cloudflareR2Adapter` default, so the domain
 * logic (encode-complete transitions, caption gating, completion,
 * certificate issuance) is exercised end-to-end against a real Postgres
 * without any network call. The *real* adapters' request-shape/signing
 * logic and "throws when unconfigured" behavior are covered separately by
 * unit tests (`tests/unit/cloudflareStreamClient.test.ts`,
 * `tests/unit/cloudflareR2Client.test.ts`).
 */

/** A deterministic fake Cloudflare Stream adapter — always "succeeds," never touches the network. */
export function fakeStreamAdapter(overrides: Partial<CloudflareStreamAdapter> = {}): CloudflareStreamAdapter {
  return {
    async createDirectUploadUrl() {
      const streamUid = newId();
      return { streamUid, uploadUrl: `https://upload.example.test/${streamUid}` };
    },
    async requestAutoCaptions() {
      // no-op: the caller (ingestVideoWebhook) flips captionStatus itself.
    },
    verifyWebhookSignature() {
      return true;
    },
    async mintSignedPlaybackUrl(streamUid, viewerId) {
      return `https://playback.example.test/${streamUid}?viewer=${viewerId}`;
    },
    ...overrides,
  };
}

/** A deterministic fake R2 adapter — always "succeeds," never touches the network. */
export function fakeR2Adapter(overrides: Partial<CertificateStorageAdapter> = {}): CertificateStorageAdapter {
  return {
    async uploadCertificatePdf(key) {
      return { r2Key: key };
    },
    ...overrides,
  };
}

/** Builds a synthetic Cloudflare Stream `readyToStream` webhook body for `ingestVideoWebhook`. */
export function readyWebhookBody(streamUid: string, durationSeconds = 120): string {
  return JSON.stringify({ uid: streamUid, status: { state: "ready" }, duration: durationSeconds, readyToStream: true });
}

/**
 * "Direct" fixture builders — insert rows straight via Prisma rather than
 * through the use cases under test, same "don't depend on the thing being
 * tested to build its own prerequisites" shape as
 * `helpers/volunteeringFixtures.ts`'s `createOpportunityDirect` family.
 * Used by the *router/REST* integration suite (`trainingRouter.
 * integration.test.ts`), which exercises the API layer, not the
 * Cloudflare-adapter-driven authoring lifecycle already covered end to
 * end by `trainingLifecycle.integration.test.ts` — no live/fake adapter
 * needed to get a `ready` + `approved` Video row for router-level tests.
 */

export async function createCourseDirect(
  prisma: PrismaClient,
  overrides: Partial<{
    slug: string;
    title: string;
    status: "draft" | "published" | "archived";
    createdByPersonId: string;
    passingCertificateEnabled: boolean;
  }> = {},
) {
  const id = newId();
  return prisma.course.create({
    data: {
      id,
      slug: overrides.slug ?? `course-${id}`,
      title: overrides.title ?? "Test Course",
      description: "A test course used by integration tests.",
      status: overrides.status ?? "published",
      publishedAt: (overrides.status ?? "published") === "published" ? new Date() : null,
      createdByPersonId: overrides.createdByPersonId ?? newId(),
      passingCertificateEnabled: overrides.passingCertificateEnabled ?? true,
    },
  });
}

/** A Module with a `ready`/`approved` Video already attached — skips Cloudflare Stream entirely. */
export async function createModuleWithReadyVideoDirect(
  prisma: PrismaClient,
  overrides: {
    courseId: string;
    sequence?: number;
    title?: string;
    isRequired?: boolean;
    durationSeconds?: number;
    transcriptText?: string;
  },
) {
  const moduleId = newId();
  await prisma.module.create({
    data: {
      id: moduleId,
      courseId: overrides.courseId,
      title: overrides.title ?? "Test Module",
      sequence: overrides.sequence ?? 1,
      isRequired: overrides.isRequired ?? true,
    },
  });
  const videoId = newId();
  await prisma.video.create({
    data: {
      id: videoId,
      moduleId,
      cloudflareStreamId: newId(),
      durationSeconds: overrides.durationSeconds ?? 100,
      encodeStatus: "ready",
      captionStatus: "approved",
      transcriptText: overrides.transcriptText ?? "A test transcript.",
    },
  });
  return { moduleId, videoId };
}

/** Attaches a Quiz (+ one Question with one correct/one incorrect Choice) to an existing Module. */
export async function createQuizDirect(
  prisma: PrismaClient,
  overrides: { moduleId: string; passingScorePercent?: number; maxAttempts?: number | null },
) {
  const quizId = newId();
  await prisma.quiz.create({
    data: {
      id: quizId,
      moduleId: overrides.moduleId,
      passingScorePercent: overrides.passingScorePercent ?? 80,
      maxAttempts: overrides.maxAttempts ?? null,
    },
  });
  const questionId = newId();
  await prisma.quizQuestion.create({
    data: { id: questionId, quizId, prompt: "What is the correct answer?", sequence: 0 },
  });
  const correctChoiceId = newId();
  const wrongChoiceId = newId();
  await prisma.quizChoice.createMany({
    data: [
      { id: correctChoiceId, questionId, label: "Correct", isCorrect: true, sequence: 0 },
      { id: wrongChoiceId, questionId, label: "Wrong", isCorrect: false, sequence: 1 },
    ],
  });
  return { quizId, questionId, correctChoiceId, wrongChoiceId };
}

/** An active Enrollment with `not_started` ModuleProgress seeded for every given `moduleId`. */
export async function createEnrollmentDirect(
  prisma: PrismaClient,
  overrides: { personId: string; courseId: string; moduleIds: string[]; status?: "active" | "completed" | "withdrawn" },
) {
  const enrollmentId = newId();
  await prisma.enrollment.create({
    data: { id: enrollmentId, personId: overrides.personId, courseId: overrides.courseId, status: overrides.status ?? "active" },
  });
  if (overrides.moduleIds.length > 0) {
    await prisma.moduleProgress.createMany({
      data: overrides.moduleIds.map((moduleId) => ({ id: newId(), enrollmentId, moduleId })),
    });
  }
  return { enrollmentId };
}

export async function createCertificateDirect(
  prisma: PrismaClient,
  overrides: {
    personId: string;
    courseId: string;
    enrollmentId: string;
    certificateNumber?: string;
    expiresAt?: Date | null;
  },
) {
  const id = newId();
  return prisma.certificate.create({
    data: {
      id,
      personId: overrides.personId,
      courseId: overrides.courseId,
      enrollmentId: overrides.enrollmentId,
      certificateNumber: overrides.certificateNumber ?? `AGF-TEST-${id}`,
      templateVersion: "v1",
      pdfFileKey: `certificates/${overrides.personId}/${overrides.enrollmentId}.pdf`,
      expiresAt: overrides.expiresAt ?? null,
    },
  });
}
