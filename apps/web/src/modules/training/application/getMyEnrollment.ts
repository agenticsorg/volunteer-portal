import type { PrismaClient } from "@prisma/client";

/**
 * GetMyEnrollment (API Contract Sketch: `getMyEnrollment({ courseId }) ->
 * EnrollmentWithProgressDTO | null`). Returns the caller's most recent
 * Enrollment (by `enrolledAt`) for the course — `active`/`completed`
 * preferred implicitly by recency, since a new Enrollment is only ever
 * created once the prior one is `withdrawn`/`completed` (Enrollment
 * invariant 1) — plus per-Module progress for resume-where-left-off.
 */
export interface ModuleProgressItem {
  moduleId: string;
  status: "not_started" | "in_progress" | "completed";
  resumePositionSeconds: number;
  watchProgressPercent: number;
  completedAt: string | null;
}

export interface EnrollmentWithProgress {
  enrollmentId: string;
  courseId: string;
  status: "active" | "completed" | "withdrawn";
  enrolledAt: string;
  completedAt: string | null;
  moduleProgress: ModuleProgressItem[];
}

export async function getMyEnrollment(
  prisma: PrismaClient,
  personId: string,
  courseId: string,
): Promise<EnrollmentWithProgress | null> {
  const enrollment = await prisma.enrollment.findFirst({
    where: { personId, courseId },
    orderBy: { enrolledAt: "desc" },
    select: {
      id: true,
      courseId: true,
      status: true,
      enrolledAt: true,
      completedAt: true,
      moduleProgress: {
        select: {
          moduleId: true,
          status: true,
          resumePositionSeconds: true,
          watchProgressPercent: true,
          completedAt: true,
        },
      },
    },
  });
  if (!enrollment) return null;

  return {
    enrollmentId: enrollment.id,
    courseId: enrollment.courseId,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    completedAt: enrollment.completedAt ? enrollment.completedAt.toISOString() : null,
    moduleProgress: enrollment.moduleProgress.map((mp) => ({
      moduleId: mp.moduleId,
      status: mp.status,
      resumePositionSeconds: mp.resumePositionSeconds,
      watchProgressPercent: mp.watchProgressPercent,
      completedAt: mp.completedAt ? mp.completedAt.toISOString() : null,
    })),
  };
}
