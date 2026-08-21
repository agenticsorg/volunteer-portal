import { Prisma } from "@prisma/client";
import type { ModuleCompletedPayload } from "../domain/inboundEvents";
import { POINTS_FOR_MODULE_COMPLETED } from "../domain/pointsConfig";
import { recordPointsForEvent } from "./recordPointsForEvent";
import { evaluateBadgeCriteria } from "./evaluateBadgeCriteria";

/**
 * `ModuleCompleted` (from `training`, docs/ddd/gamification.md's Consumed
 * Domain Events table): "Awards points; evaluates module-level badge
 * criteria." No streak is extended here — only `HoursApproved`
 * (`shift_cadence`) and `CourseCompleted` (`training_cadence`) feed streaks,
 * per that table. Called by `consumeInboundEvent` only after the
 * `processed_events` idempotency check has already succeeded.
 */
export async function handleModuleCompleted(
  tx: Prisma.TransactionClient,
  payload: ModuleCompletedPayload,
  sourceEventId: string,
): Promise<void> {
  const { totalPoints } = await recordPointsForEvent(tx, {
    personId: payload.personId,
    points: POINTS_FOR_MODULE_COMPLETED,
    sourceEventType: "ModuleCompleted",
    sourceEventId,
  });

  await evaluateBadgeCriteria(tx, {
    personId: payload.personId,
    sourceEventId,
    totalPoints,
    moduleCompletedId: payload.moduleId,
  });
}
