import type { PrismaClient } from "@prisma/client";
import { CourseNotFoundError } from "../domain/errors";

export interface CourseSummary {
  courseId: string;
  slug: string;
  title: string;
  description: string;
  status: "draft" | "published" | "archived";
  publishedAt: string | null;
}

/** GetCourseCatalog (API Contract Sketch: `getCourseCatalog({ status }) -> CourseSummaryDTO[]`). Public read. */
export async function getCourseCatalog(
  prisma: PrismaClient,
  status: "draft" | "published" | "archived" = "published",
): Promise<CourseSummary[]> {
  const courses = await prisma.course.findMany({
    where: { status },
    orderBy: { publishedAt: "desc" },
    select: { id: true, slug: true, title: true, description: true, status: true, publishedAt: true },
  });

  return courses.map((c) => ({
    courseId: c.id,
    slug: c.slug,
    title: c.title,
    description: c.description,
    status: c.status,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
  }));
}

export interface ModuleSummary {
  moduleId: string;
  title: string;
  sequence: number;
  isRequired: boolean;
  prerequisiteModuleIds: string[];
  video: { videoId: string; durationSeconds: number | null; captionStatus: string } | null;
  quiz: { quizId: string; passingScorePercent: number } | null;
}

export interface CourseDetail extends CourseSummary {
  modules: ModuleSummary[];
}

/** Course detail (with its ordered Modules) for a course-catalog detail page. */
export async function getCourseById(prisma: PrismaClient, courseId: string): Promise<CourseDetail> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      status: true,
      publishedAt: true,
      modules: {
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          title: true,
          sequence: true,
          isRequired: true,
          dependsOn: { select: { prerequisiteModuleId: true } },
          video: { select: { id: true, durationSeconds: true, captionStatus: true } },
          quiz: { select: { id: true, passingScorePercent: true } },
        },
      },
    },
  });
  if (!course) {
    throw new CourseNotFoundError(courseId);
  }

  return {
    courseId: course.id,
    slug: course.slug,
    title: course.title,
    description: course.description,
    status: course.status,
    publishedAt: course.publishedAt ? course.publishedAt.toISOString() : null,
    modules: course.modules.map((m) => ({
      moduleId: m.id,
      title: m.title,
      sequence: m.sequence,
      isRequired: m.isRequired,
      prerequisiteModuleIds: m.dependsOn.map((d) => d.prerequisiteModuleId),
      video: m.video ? { videoId: m.video.id, durationSeconds: m.video.durationSeconds, captionStatus: m.video.captionStatus } : null,
      quiz: m.quiz ? { quizId: m.quiz.id, passingScorePercent: m.quiz.passingScorePercent } : null,
    })),
  };
}
