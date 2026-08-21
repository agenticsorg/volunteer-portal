import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { getPersonSummary } from "@/modules/identity";
import { logger } from "@/server/observability/logger";
import { buildCertificatePdf } from "../infra/certificatePdf";
import { cloudflareR2Adapter, type CertificateStorageAdapter } from "../infra/cloudflareR2Client";
import { isModuleReadyToComplete, isCourseReadyToComplete } from "../domain/moduleCompletionRule";

/**
 * The module-completion invariant (docs/ddd/training-learning.md, Module
 * invariant 1) and the Enrollment-completion invariant (Enrollment
 * invariant 3), evaluated together as one unit because both `RecordProgress`
 * (Key Use Case 7) and `SubmitQuizAttempt` (Key Use Case 8) can trigger
 * either or both — a passed quiz attempt can complete a module that
 * already had `watchProgressPercent >= 90`, and completing the *last*
 * required module of a course completes the Enrollment.
 *
 * Must be called from *inside* the caller's own `prisma.$transaction`
 * block — every write here (ModuleProgress, Enrollment, the
 * ModuleCompleted/CourseCompleted/CertificateIssued outbox rows, and the
 * Certificate row itself) commits atomically with whatever change
 * triggered the re-evaluation (Certificate invariant 2: "only ever created
 * as a direct, same-transaction side effect of an Enrollment reaching
 * `status = 'completed'`").
 */
export interface EvaluateCompletionArgs {
  enrollmentId: string;
  moduleId: string;
}

export interface CompletionResult {
  moduleStatus: "not_started" | "in_progress" | "completed";
  courseCompleted: boolean;
  /** Set when this call is what triggered course completion + certificate issuance. */
  issuedCertificateId: string | null;
}

/** `AGF-{year}-{ULID suffix}` — human-readable per the doc's own example ("AGF-2026-000482"). */
function generateCertificateNumber(now: Date): string {
  const suffix = newId().slice(-8).toUpperCase();
  return `AGF-${now.getUTCFullYear()}-${suffix}`;
}

export async function evaluateModuleAndCourseCompletion(
  tx: Prisma.TransactionClient,
  args: EvaluateCompletionArgs,
): Promise<CompletionResult> {
  const progress = await tx.moduleProgress.findUniqueOrThrow({
    where: { enrollmentId_moduleId: { enrollmentId: args.enrollmentId, moduleId: args.moduleId } },
  });

  let moduleStatus = progress.status;

  if (moduleStatus !== "completed") {
    const quiz = await tx.quiz.findUnique({ where: { moduleId: args.moduleId }, select: { id: true } });
    const quizPassed = quiz
      ? (await tx.quizAttempt.findFirst({
          where: { enrollmentId: args.enrollmentId, quizId: quiz.id, passed: true },
          select: { id: true },
        })) !== null
      : true;

    if (isModuleReadyToComplete(progress.watchProgressPercent, quizPassed)) {
      const completedAt = new Date();
      await tx.moduleProgress.update({
        where: { id: progress.id },
        data: { status: "completed", completedAt },
      });
      moduleStatus = "completed";

      const enrollment = await tx.enrollment.findUniqueOrThrow({
        where: { id: args.enrollmentId },
        select: { personId: true, courseId: true },
      });

      await tx.trainingDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "ModuleProgress",
          aggregateId: progress.id,
          eventType: "ModuleCompleted",
          payload: {
            enrollmentId: args.enrollmentId,
            personId: enrollment.personId,
            courseId: enrollment.courseId,
            moduleId: args.moduleId,
          } satisfies Prisma.InputJsonValue,
        },
      });
    }
  }

  if (moduleStatus !== "completed") {
    return { moduleStatus, courseCompleted: false, issuedCertificateId: null };
  }

  return completeCourseIfEligible(tx, args.enrollmentId);
}

/**
 * Enrollment invariant 3: `status` transitions to `completed` only once
 * every `isRequired = true` Module has `ModuleProgress.status =
 * 'completed'`. Certificate invariant 2: issuing a Certificate is a
 * direct, same-transaction side effect of that transition (never a
 * separately user-triggered action) when `Course.passingCertificateEnabled`.
 */
async function completeCourseIfEligible(
  tx: Prisma.TransactionClient,
  enrollmentId: string,
): Promise<CompletionResult> {
  const enrollment = await tx.enrollment.findUniqueOrThrow({
    where: { id: enrollmentId },
    select: {
      id: true,
      personId: true,
      courseId: true,
      status: true,
      course: { select: { title: true, passingCertificateEnabled: true } },
    },
  });

  if (enrollment.status === "completed") {
    return { moduleStatus: "completed", courseCompleted: true, issuedCertificateId: null };
  }

  const requiredModules = await tx.module.findMany({
    where: { courseId: enrollment.courseId, isRequired: true },
    select: { id: true },
  });
  const completedRequired = await tx.moduleProgress.count({
    where: {
      enrollmentId,
      status: "completed",
      moduleId: { in: requiredModules.map((m) => m.id) },
    },
  });

  if (!isCourseReadyToComplete(requiredModules.length, completedRequired)) {
    return { moduleStatus: "completed", courseCompleted: false, issuedCertificateId: null };
  }

  const completedAt = new Date();
  await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: "completed", completedAt } });

  await tx.trainingDomainEvent.create({
    data: {
      id: newId(),
      aggregateType: "Enrollment",
      aggregateId: enrollment.id,
      eventType: "CourseCompleted",
      payload: {
        enrollmentId: enrollment.id,
        personId: enrollment.personId,
        courseId: enrollment.courseId,
        completedAt: completedAt.toISOString(),
      } satisfies Prisma.InputJsonValue,
    },
  });

  let issuedCertificateId: string | null = null;
  if (enrollment.course.passingCertificateEnabled) {
    const certificateId = newId();
    const certificateNumber = generateCertificateNumber(completedAt);

    await tx.certificate.create({
      data: {
        id: certificateId,
        personId: enrollment.personId,
        courseId: enrollment.courseId,
        enrollmentId: enrollment.id,
        certificateNumber,
        templateVersion: "v1",
        issuedAt: completedAt,
      },
    });

    await tx.trainingDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Certificate",
        aggregateId: certificateId,
        eventType: "CertificateIssued",
        payload: {
          certificateId,
          personId: enrollment.personId,
          courseId: enrollment.courseId,
          certificateNumber,
        } satisfies Prisma.InputJsonValue,
      },
    });

    issuedCertificateId = certificateId;
  }

  return { moduleStatus: "completed", courseCompleted: true, issuedCertificateId };
}

/**
 * Renders and uploads the certificate PDF to R2, then records
 * `pdf_file_key` — the "rendered async, via a queued job" half of
 * IssueCertificate (Key Use Case 9). Deliberately run *after* the
 * transaction that created the `Certificate` row commits (a network call
 * has no place inside a DB transaction), and deliberately best-effort:
 * this phase has no background-job runner wired up yet to retry a failed
 * render, so a missing Cloudflare R2 credential (or any render/upload
 * failure) is swallowed here and logged — the Certificate row (the proof
 * of completion) still exists and `pdfFileKey` simply stays `null` until a
 * future retry (a real queued job in a later phase) fills it in. This is
 * the one place in this module that deliberately does NOT propagate an
 * `ExternalServiceNotConfiguredError` outward — the adapter itself still
 * throws it correctly (never fakes success); this caller chooses to
 * degrade gracefully rather than fail the learner-facing
 * RecordProgress/SubmitQuizAttempt call that triggered completion — every
 * error (not just "not configured") is caught and logged here for exactly
 * that reason, so every call site can invoke this without its own
 * try/catch.
 */
export async function renderAndStoreCertificatePdf(
  prisma: PrismaClient,
  certificateId: string,
  adapter: CertificateStorageAdapter = cloudflareR2Adapter,
): Promise<void> {
  try {
    const certificate = await prisma.certificate.findUniqueOrThrow({
      where: { id: certificateId },
      select: { id: true, personId: true, courseId: true, certificateNumber: true, issuedAt: true },
    });
    const [person, course] = await Promise.all([
      getPersonSummary(prisma, certificate.personId),
      prisma.course.findUniqueOrThrow({ where: { id: certificate.courseId }, select: { title: true } }),
    ]);

    const pdfBytes = buildCertificatePdf({
      certificateNumber: certificate.certificateNumber,
      recipientDisplayName: person?.displayName ?? "Volunteer",
      courseTitle: course.title,
      issuedAtIso: certificate.issuedAt.toISOString(),
    });

    const key = `certificates/${certificate.personId}/${certificate.id}.pdf`;
    const { r2Key } = await adapter.uploadCertificatePdf(key, pdfBytes);

    await prisma.certificate.update({ where: { id: certificate.id }, data: { pdfFileKey: r2Key } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("training.certificate_pdf_render_failed", {
      subjectId: certificateId,
      context: { certificateId, message, willRetry: true },
    });
  }
}
