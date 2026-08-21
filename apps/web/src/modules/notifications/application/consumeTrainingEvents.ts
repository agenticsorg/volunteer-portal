import type { PrismaClient } from "@prisma/client";
import type { CertificateIssuedPayload, CourseCompletedPayload, InboundEvent } from "../domain/inboundEvents";
import { handleCourseCompleted } from "./handlers/training/courseCompleted";
import { handleCertificateIssued } from "./handlers/training/certificateIssued";
import type { ConsumptionResult } from "./idempotentConsumption";
import type { ConsumeEventResult } from "./consumeVolunteeringEvents";

const RECOGNIZED_EVENT_TYPES = ["CourseCompleted", "CertificateIssued"] as const;

/**
 * `ConsumeTrainingEvents` — see `consumeVolunteeringEvents.ts`'s own doc
 * comment for the shared design rationale. Handles `training.domain_events`'
 * `CourseCompleted` and `CertificateIssued` (`ModuleCompleted` is also
 * published by `training` but is not in this stage's Build list — a
 * per-module-progress event notifications has no use for; a normal
 * `recognized: false` no-op).
 */
export async function consumeTrainingEvents(prisma: PrismaClient, event: InboundEvent): Promise<ConsumeEventResult> {
  if (!RECOGNIZED_EVENT_TYPES.includes(event.eventType as (typeof RECOGNIZED_EVENT_TYPES)[number])) {
    return { processed: false, recognized: false };
  }

  let result: ConsumptionResult;
  switch (event.eventType) {
    case "CourseCompleted":
      result = await handleCourseCompleted(prisma, event.payload as CourseCompletedPayload, event.sourceEventId);
      break;
    case "CertificateIssued":
      result = await handleCertificateIssued(prisma, event.payload as CertificateIssuedPayload, event.sourceEventId);
      break;
    default:
      return { processed: false, recognized: false };
  }

  return { processed: result.processed, recognized: true };
}
