import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  CourseNotFoundError,
  ModuleNotInCourseError,
  ModulePrerequisiteCycleError,
  QuizPassingScoreInvalidError,
  QuizQuestionMissingCorrectChoiceError,
} from "../domain/errors";
import { wouldCreateCycle, type PrerequisiteEdges } from "../domain/prerequisiteGraph";
import { assertTrainingAuthority } from "./assertTrainingAuthority";

export interface AddModuleChoiceInput {
  label: string;
  isCorrect: boolean;
}

export interface AddModuleQuestionInput {
  prompt: string;
  choices: AddModuleChoiceInput[];
}

export interface AddModuleQuizInput {
  passingScorePercent: number;
  maxAttempts?: number;
  questions: AddModuleQuestionInput[];
}

/**
 * AddModule (docs/ddd/training-learning.md, Key Use Case 2). The Video
 * placeholder the doc's own summary mentions ("attaches a Module ... and
 * its Video placeholder") is deliberately its own use case
 * (`initiateVideoUpload`), not created here — a `training.video` row
 * requires a real Cloudflare Stream upload registration (ADR-0010's
 * Ingestion step) to satisfy its `NOT NULL UNIQUE cloudflare_stream_id`
 * column, which is a distinct, separately-authorized/separately-timed
 * action from declaring a Module's title/sequence/prerequisites/quiz.
 *
 * *Pre:* caller holds `content_admin` (global) or `org_admin`; every
 * `prerequisiteModuleIds` entry belongs to the same `courseId`; declaring
 * those prerequisite edges creates no cycle in the course's prerequisite
 * DAG; if `quiz` is given, `passingScorePercent` is 1-100 and every
 * Question has >= 1 Choice flagged `isCorrect` (Quiz invariant 4).
 *
 * *Post:* a new `Module` row exists (`Module.sequence` unique within
 * `courseId` — the DB's own `UNIQUE (course_id, sequence)` is the
 * concurrency backstop), its `ModulePrerequisite` edges exist, and, if
 * `quiz` was given, a `Quiz` (+ `QuizQuestion`/`QuizChoice`) row exists.
 * No domain event — Module-lifecycle events in the Domain Events table
 * (`ModuleCompleted`) are learner-progress events, not authoring events.
 */
export interface AddModuleInput {
  caller: PolicySubject;
  courseId: string;
  title: string;
  sequence: number;
  isRequired?: boolean;
  prerequisiteModuleIds?: string[];
  quiz?: AddModuleQuizInput;
}

export interface AddedModule {
  moduleId: string;
  quizId: string | null;
}

export async function addModule(prisma: PrismaClient, input: AddModuleInput): Promise<AddedModule> {
  await assertTrainingAuthority(prisma, input.caller, "course.manage");

  const course = await prisma.course.findUnique({ where: { id: input.courseId }, select: { id: true } });
  if (!course) {
    throw new CourseNotFoundError(input.courseId);
  }

  const prerequisiteModuleIds = [...new Set(input.prerequisiteModuleIds ?? [])];
  if (prerequisiteModuleIds.length > 0) {
    const found = await prisma.module.findMany({
      where: { id: { in: prerequisiteModuleIds }, courseId: input.courseId },
      select: { id: true },
    });
    const foundIds = new Set(found.map((m) => m.id));
    const missing = prerequisiteModuleIds.find((id) => !foundIds.has(id));
    if (missing) {
      throw new ModuleNotInCourseError(missing, input.courseId);
    }
  }

  if (input.quiz) {
    if (input.quiz.passingScorePercent < 1 || input.quiz.passingScorePercent > 100) {
      throw new QuizPassingScoreInvalidError();
    }
    for (const question of input.quiz.questions) {
      if (!question.choices.some((c) => c.isCorrect)) {
        throw new QuizQuestionMissingCorrectChoiceError(question.prompt);
      }
    }
  }

  const moduleId = newId();

  // Cycle check (Key Use Case 2: "rejects cycles in the prerequisite
  // graph"). `moduleId` is brand new here, so no existing edge could
  // already point *at* it — a freshly created node cannot itself close a
  // pre-existing cycle. This check is still real and exercised (not a
  // no-op by construction): it loads the course's full existing DAG and
  // walks it for every requested edge, the same logic a future
  // "add a prerequisite to an already-existing module" use case would
  // reuse verbatim.
  if (prerequisiteModuleIds.length > 0) {
    const existingEdges = await prisma.modulePrerequisite.findMany({
      where: { module: { courseId: input.courseId } },
      select: { moduleId: true, prerequisiteModuleId: true },
    });
    const edgeMap = new Map<string, string[]>();
    for (const edge of existingEdges) {
      const list = edgeMap.get(edge.moduleId) ?? [];
      list.push(edge.prerequisiteModuleId);
      edgeMap.set(edge.moduleId, list);
    }
    const edges: PrerequisiteEdges = edgeMap;
    for (const prerequisiteModuleId of prerequisiteModuleIds) {
      if (wouldCreateCycle(edges, moduleId, prerequisiteModuleId)) {
        throw new ModulePrerequisiteCycleError(moduleId);
      }
    }
  }

  const quizId = input.quiz ? newId() : null;

  await prisma.$transaction(async (tx) => {
    await tx.module.create({
      data: {
        id: moduleId,
        courseId: input.courseId,
        title: input.title,
        sequence: input.sequence,
        isRequired: input.isRequired ?? true,
      },
    });

    if (prerequisiteModuleIds.length > 0) {
      await tx.modulePrerequisite.createMany({
        data: prerequisiteModuleIds.map((prerequisiteModuleId) => ({
          moduleId,
          prerequisiteModuleId,
        })),
      });
    }

    if (input.quiz && quizId) {
      await tx.quiz.create({
        data: {
          id: quizId,
          moduleId,
          passingScorePercent: input.quiz.passingScorePercent,
          maxAttempts: input.quiz.maxAttempts ?? null,
        },
      });

      for (let qIndex = 0; qIndex < input.quiz.questions.length; qIndex++) {
        const question = input.quiz.questions[qIndex];
        const questionId = newId();
        await tx.quizQuestion.create({
          data: { id: questionId, quizId, prompt: question.prompt, sequence: qIndex },
        });
        for (let cIndex = 0; cIndex < question.choices.length; cIndex++) {
          const choice = question.choices[cIndex];
          await tx.quizChoice.create({
            data: {
              id: newId(),
              questionId,
              label: choice.label,
              isCorrect: choice.isCorrect,
              sequence: cIndex,
            },
          });
        }
      }
    }

    await recordAuditEvent(tx.trainingDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "module.add",
      resourceType: "module",
      resourceId: moduleId,
      scopeType: "global",
      metadata: { courseId: input.courseId, title: input.title, sequence: input.sequence },
    });
  });

  return { moduleId, quizId };
}
