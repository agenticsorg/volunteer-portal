import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import {
  EnrollmentNotFoundError,
  NotEnrolledError,
  QuizAnswersInvalidError,
  QuizMaxAttemptsExceededError,
  QuizNotFoundError,
} from "../domain/errors";
import { cloudflareR2Adapter, type CertificateStorageAdapter } from "../infra/cloudflareR2Client";
import { evaluateModuleAndCourseCompletion, renderAndStoreCertificatePdf } from "./moduleCompletion";

/**
 * SubmitQuizAttempt (docs/ddd/training-learning.md, Key Use Case 8).
 * Self-service — the learner submits their own attempt, not `can()`-gated.
 *
 * *Pre:* the caller holds an `active` Enrollment in the Quiz's Module's
 * Course; `answers` supplies exactly one Choice per the Quiz's Questions,
 * every `questionId`/`choiceId` pair genuinely belongs to this Quiz
 * (Quiz Attempt Answer invariant); the learner has not already reached
 * `Quiz.maxAttempts` attempts for this Enrollment (Enrollment invariant 4).
 *
 * *Post:* a `QuizAttempt` (+ per-answer rows) is persisted — failed
 * attempts are retained for history, never deleted, and count against
 * `maxAttempts`. On a pass (`scorePercent >= passingScorePercent`), the
 * shared module/course-completion check runs (same as `RecordProgress`,
 * since a passing attempt can complete a module whose watch progress was
 * already >= 90%). On a fail, `QuizAttemptFailed` is emitted instead.
 */
export interface SubmitQuizAttemptAnswerInput {
  questionId: string;
  choiceId: string;
}

export interface SubmitQuizAttemptInput {
  personId: string;
  enrollmentId: string;
  quizId: string;
  answers: SubmitQuizAttemptAnswerInput[];
}

export interface SubmittedQuizAttempt {
  scorePercent: number;
  passed: boolean;
  moduleStatus: "not_started" | "in_progress" | "completed";
  courseCompleted: boolean;
}

export async function submitQuizAttempt(
  prisma: PrismaClient,
  input: SubmitQuizAttemptInput,
  r2Adapter: CertificateStorageAdapter = cloudflareR2Adapter,
): Promise<SubmittedQuizAttempt> {
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

  const quiz = await prisma.quiz.findUnique({
    where: { id: input.quizId },
    select: {
      id: true,
      moduleId: true,
      passingScorePercent: true,
      maxAttempts: true,
      module: { select: { courseId: true } },
      questions: { select: { id: true, choices: { select: { id: true, isCorrect: true } } } },
    },
  });
  if (!quiz || quiz.module.courseId !== enrollment.courseId) {
    throw new QuizNotFoundError(input.quizId);
  }

  if (quiz.maxAttempts !== null) {
    const attemptCount = await prisma.quizAttempt.count({
      where: { enrollmentId: input.enrollmentId, quizId: quiz.id },
    });
    if (attemptCount >= quiz.maxAttempts) {
      throw new QuizMaxAttemptsExceededError(quiz.id);
    }
  }

  if (input.answers.length !== quiz.questions.length) {
    throw new QuizAnswersInvalidError(
      quiz.id,
      `expected exactly one answer per question (${quiz.questions.length}), got ${input.answers.length}.`,
    );
  }

  const questionsById = new Map(quiz.questions.map((q) => [q.id, q]));
  const answeredQuestionIds = new Set<string>();
  let correctCount = 0;

  for (const answer of input.answers) {
    const question = questionsById.get(answer.questionId);
    if (!question) {
      throw new QuizAnswersInvalidError(quiz.id, `question "${answer.questionId}" does not belong to this quiz.`);
    }
    if (answeredQuestionIds.has(answer.questionId)) {
      throw new QuizAnswersInvalidError(quiz.id, `question "${answer.questionId}" was answered more than once.`);
    }
    answeredQuestionIds.add(answer.questionId);

    const choice = question.choices.find((c) => c.id === answer.choiceId);
    if (!choice) {
      throw new QuizAnswersInvalidError(
        quiz.id,
        `choice "${answer.choiceId}" does not belong to question "${answer.questionId}".`,
      );
    }
    if (choice.isCorrect) correctCount++;
  }

  const scorePercent = quiz.questions.length === 0 ? 100 : Math.round((correctCount / quiz.questions.length) * 100);
  const passed = scorePercent >= quiz.passingScorePercent;
  const attemptId = newId();

  const completion = await prisma.$transaction(async (tx) => {
    await tx.quizAttempt.create({
      data: { id: attemptId, enrollmentId: input.enrollmentId, quizId: quiz.id, scorePercent, passed },
    });

    await tx.quizAttemptAnswer.createMany({
      data: input.answers.map((answer) => ({
        attemptId,
        questionId: answer.questionId,
        choiceId: answer.choiceId,
        isCorrect: questionsById.get(answer.questionId)!.choices.some(
          (c) => c.id === answer.choiceId && c.isCorrect,
        ),
      })),
    });

    if (passed) {
      return evaluateModuleAndCourseCompletion(tx, {
        enrollmentId: input.enrollmentId,
        moduleId: quiz.moduleId,
      });
    }

    await tx.trainingDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "QuizAttempt",
        aggregateId: attemptId,
        eventType: "QuizAttemptFailed",
        payload: {
          enrollmentId: input.enrollmentId,
          quizId: quiz.id,
          scorePercent,
        } satisfies Prisma.InputJsonValue,
      },
    });
    return null;
  });

  if (completion?.issuedCertificateId) {
    await renderAndStoreCertificatePdf(prisma, completion.issuedCertificateId, r2Adapter);
  }

  const currentModuleProgress = await prisma.moduleProgress.findUniqueOrThrow({
    where: { enrollmentId_moduleId: { enrollmentId: input.enrollmentId, moduleId: quiz.moduleId } },
    select: { status: true },
  });

  return {
    scorePercent,
    passed,
    moduleStatus: currentModuleProgress.status,
    courseCompleted: completion?.courseCompleted ?? false,
  };
}
