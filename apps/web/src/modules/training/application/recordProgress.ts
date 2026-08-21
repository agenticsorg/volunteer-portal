import type { PrismaClient } from "@prisma/client";
import {
  EnrollmentNotFoundError,
  ModuleNotFoundError,
  ModulePrerequisitesNotMetError,
  NotEnrolledError,
  RecordProgressInputInvalidError,
  ResumePositionExceedsDurationError,
} from "../domain/errors";
import { cloudflareR2Adapter, type CertificateStorageAdapter } from "../infra/cloudflareR2Client";
import { evaluateModuleAndCourseCompletion, renderAndStoreCertificatePdf } from "./moduleCompletion";

/**
 * RecordProgress (docs/ddd/training-learning.md, Key Use Case 7).
 * Self-service, idempotent — safe to call repeatedly with the same or a
 * lower `watchProgressPercent` (e.g. the video player's periodic 10-15s
 * heartbeat), since both fields are only ever moved forward (`Math.max`
 * against the stored value), matching Watch Progress's own definition
 * ("the furthest percentage ... watched").
 *
 * *Pre:* the caller (`personId`) holds an `active` Enrollment in the
 * Module's Course; the Module's prerequisite modules are all `completed`
 * in that Enrollment (Module invariant 2) — checked whenever this call
 * would actually move progress forward, not on a plain resume-position
 * heartbeat that reports no new watch percentage; `resumePositionSeconds`
 * does not exceed the Video's `durationSeconds` (Enrollment invariant 2).
 *
 * *Post:* `ModuleProgress` updated; when `watchProgressPercent` crosses 90
 * (and any attached Quiz is already passed, or there is no Quiz — Module
 * invariant 1), the module completes and the shared completion-evaluation
 * logic (`moduleCompletion.ts`) runs, possibly also completing the
 * Enrollment and issuing a Certificate — emitting `ModuleCompleted`
 * and/or `CourseCompleted`/`CertificateIssued` accordingly, all in the
 * same transaction as the `ModuleProgress` write.
 */
export interface RecordProgressInput {
  personId: string;
  enrollmentId: string;
  moduleId: string;
  resumePositionSeconds: number;
  watchProgressPercent: number;
}

export interface RecordProgressResult {
  moduleStatus: "not_started" | "in_progress" | "completed";
  courseCompleted: boolean;
}

export async function recordProgress(
  prisma: PrismaClient,
  input: RecordProgressInput,
  r2Adapter: CertificateStorageAdapter = cloudflareR2Adapter,
): Promise<RecordProgressResult> {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: input.enrollmentId },
    select: { id: true, personId: true, courseId: true, status: true },
  });
  if (!enrollment) {
    throw new EnrollmentNotFoundError(input.enrollmentId);
  }
  if (enrollment.personId !== input.personId || enrollment.status === "withdrawn") {
    throw new NotEnrolledError(input.personId, enrollment.courseId);
  }

  const targetModule = await prisma.module.findUnique({
    where: { id: input.moduleId, courseId: enrollment.courseId },
    select: {
      id: true,
      video: { select: { durationSeconds: true } },
      dependsOn: { select: { prerequisiteModuleId: true } },
    },
  });
  if (!targetModule) {
    throw new ModuleNotFoundError(input.moduleId);
  }

  if (input.resumePositionSeconds < 0) {
    throw new RecordProgressInputInvalidError("resumePositionSeconds must be >= 0.");
  }
  if (input.watchProgressPercent < 0 || input.watchProgressPercent > 100) {
    throw new RecordProgressInputInvalidError("watchProgressPercent must be between 0 and 100.");
  }
  if (
    targetModule.video?.durationSeconds != null &&
    input.resumePositionSeconds > targetModule.video.durationSeconds
  ) {
    throw new ResumePositionExceedsDurationError(input.moduleId);
  }

  const existingProgress = await prisma.moduleProgress.findUniqueOrThrow({
    where: { enrollmentId_moduleId: { enrollmentId: input.enrollmentId, moduleId: input.moduleId } },
  });

  const isAdvancingProgress =
    input.watchProgressPercent > existingProgress.watchProgressPercent ||
    input.resumePositionSeconds > existingProgress.resumePositionSeconds;

  if (isAdvancingProgress && existingProgress.status === "not_started" && targetModule.dependsOn.length > 0) {
    const prerequisiteIds = targetModule.dependsOn.map((d) => d.prerequisiteModuleId);
    const completedPrerequisites = await prisma.moduleProgress.count({
      where: { enrollmentId: input.enrollmentId, moduleId: { in: prerequisiteIds }, status: "completed" },
    });
    if (completedPrerequisites < prerequisiteIds.length) {
      throw new ModulePrerequisitesNotMetError(input.moduleId);
    }
  }

  const nextWatchProgressPercent = Math.max(existingProgress.watchProgressPercent, input.watchProgressPercent);
  const nextResumePositionSeconds = Math.max(existingProgress.resumePositionSeconds, input.resumePositionSeconds);

  let completion!: Awaited<ReturnType<typeof evaluateModuleAndCourseCompletion>>;
  await prisma.$transaction(async (tx) => {
    if (existingProgress.status !== "completed") {
      await tx.moduleProgress.update({
        where: { id: existingProgress.id },
        data: {
          resumePositionSeconds: nextResumePositionSeconds,
          watchProgressPercent: nextWatchProgressPercent,
          status: nextWatchProgressPercent > 0 || nextResumePositionSeconds > 0 ? "in_progress" : "not_started",
        },
      });
    }

    completion = await evaluateModuleAndCourseCompletion(tx, {
      enrollmentId: input.enrollmentId,
      moduleId: input.moduleId,
    });
  });

  if (completion.issuedCertificateId) {
    await renderAndStoreCertificatePdf(prisma, completion.issuedCertificateId, r2Adapter);
  }

  return { moduleStatus: completion.moduleStatus, courseCompleted: completion.courseCompleted };
}
