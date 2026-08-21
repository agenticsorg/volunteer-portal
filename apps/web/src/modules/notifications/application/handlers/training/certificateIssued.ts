import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import { getCourseById, CourseNotFoundError as TrainingCourseNotFoundError } from "@/modules/training";
import type { CertificateIssuedPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleCertificateIssued` — mirrors `training`'s `CertificateIssued`
 * producer (`application/moduleCompletion.ts`). Same course-title
 * resolution as `handleCourseCompleted.ts` (the payload carries only
 * `courseId`); `certificateNumber` is already on the payload directly, no
 * further lookup needed. `payload.personId` is validated via
 * `identity.getPersonSummary`, same defense-in-depth precedent every
 * other handler in this module applies.
 *
 * Recipient: `payload.personId`. `certificate_issued` is an operational/
 * transactional type, defaulted enabled on both channels.
 */
export async function handleCertificateIssued(
  prisma: PrismaClient,
  payload: CertificateIssuedPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const person = await getPersonSummary(prisma, payload.personId);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }

  let courseTitle: string;
  try {
    const course = await getCourseById(prisma, payload.courseId);
    courseTitle = course.title;
  } catch (error) {
    if (error instanceof TrainingCourseNotFoundError) {
      throw new SourceRecordNotFoundError("training.course", payload.courseId);
    }
    throw error;
  }

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "training", eventType: "CertificateIssued" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.personId,
        type: "certificate_issued",
        requestedChannels: ["email", "in_app"],
        sourceContext: "training",
        sourceEventId,
        payload: { certificateId: payload.certificateId, certificateNumber: payload.certificateNumber, courseTitle },
      });
    },
  );
}
