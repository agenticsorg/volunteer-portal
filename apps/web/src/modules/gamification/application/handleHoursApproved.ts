import { Prisma } from "@prisma/client";
import type { HoursApprovedPayload } from "../domain/inboundEvents";
import { computeHoursApprovedPoints } from "../domain/pointsConfig";
import { recordPointsForEvent } from "./recordPointsForEvent";
import { updateStreak } from "./updateStreak";
import { evaluateBadgeCriteria } from "./evaluateBadgeCriteria";

/**
 * `HoursApproved` (from `volunteering`, docs/ddd/gamification.md's Consumed
 * Domain Events table): "Awards points via `RecordPointsForEvent`; extends
 * `shift_cadence` streak." Called by `consumeInboundEvent` only after the
 * `processed_events` idempotency check has already succeeded for this event
 * — this handler itself performs no idempotency check of its own.
 */
export async function handleHoursApproved(
  tx: Prisma.TransactionClient,
  payload: HoursApprovedPayload,
  sourceEventId: string,
): Promise<void> {
  const points = computeHoursApprovedPoints(payload.durationMinutes);

  const { totalPoints } = await recordPointsForEvent(tx, {
    personId: payload.personId,
    points,
    sourceEventType: "HoursApproved",
    sourceEventId,
  });

  const streak = await updateStreak(tx, {
    personId: payload.personId,
    activityType: "shift_cadence",
    activityDate: new Date(payload.approvedAt),
  });

  await evaluateBadgeCriteria(tx, {
    personId: payload.personId,
    sourceEventId,
    totalPoints,
    streak: { activityType: "shift_cadence", currentLength: streak.currentLength },
  });
}
