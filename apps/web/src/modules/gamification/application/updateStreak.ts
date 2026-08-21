import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { applyStreakActivity, type StreakState, type StreakStatus } from "../domain/streakRules";
import { publishGamificationEvent } from "./publishGamificationEvent";

export interface UpdateStreakInput {
  personId: string;
  /** e.g. `shift_cadence`, `training_cadence` — plain text, app-level allow-list, not a DB enum (extensible without a migration). */
  activityType: string;
  activityDate: Date;
}

export interface UpdateStreakResult {
  streakId: string;
  currentLength: number;
  status: StreakStatus;
}

/**
 * UpdateStreak (docs/ddd/gamification.md, Key Use Case 5): loads the
 * person's `Streak` row for `activityType` (or treats it as absent —
 * `applyStreakActivity` handles first-ever activity), applies the streak
 * state machine (`domain/streakRules.ts`), persists the result, and
 * publishes `StreakExtended` / `StreakFrozen` / `StreakBroken` accordingly.
 * A same-cadence-window repeat activity is a genuine no-op: no write, no
 * event, `null`-equivalent handled by returning the unchanged snapshot.
 * Must be called from *inside* the caller's own `prisma.$transaction`.
 */
export async function updateStreak(
  tx: Prisma.TransactionClient,
  input: UpdateStreakInput,
): Promise<UpdateStreakResult> {
  const existing = await tx.streak.findUnique({
    where: { personId_activityType: { personId: input.personId, activityType: input.activityType } },
  });

  const currentState: StreakState | null = existing
    ? {
        currentLength: existing.currentLength,
        longestLength: existing.longestLength,
        lastActivityDate: existing.lastActivityDate,
        freezesAvailable: existing.freezesAvailable,
        freezesUsedTotal: existing.freezesUsedTotal,
        status: existing.status,
      }
    : null;

  const outcome = applyStreakActivity(currentState, input.activityDate);

  if (outcome.kind === "unchanged") {
    return {
      streakId: existing?.id ?? "",
      currentLength: outcome.state.currentLength,
      status: outcome.state.status,
    };
  }

  const streakId = existing?.id ?? newId();
  const { state } = outcome;

  await tx.streak.upsert({
    where: { personId_activityType: { personId: input.personId, activityType: input.activityType } },
    create: {
      id: streakId,
      personId: input.personId,
      activityType: input.activityType,
      currentLength: state.currentLength,
      longestLength: state.longestLength,
      lastActivityDate: state.lastActivityDate,
      freezesAvailable: state.freezesAvailable,
      freezesUsedTotal: state.freezesUsedTotal,
      status: state.status,
    },
    update: {
      currentLength: state.currentLength,
      longestLength: state.longestLength,
      lastActivityDate: state.lastActivityDate,
      freezesAvailable: state.freezesAvailable,
      freezesUsedTotal: state.freezesUsedTotal,
      status: state.status,
    },
  });

  if (outcome.kind === "extended") {
    await publishGamificationEvent(tx, {
      eventType: "StreakExtended",
      aggregateType: "Streak",
      aggregateId: streakId,
      payload: { personId: input.personId, activityType: input.activityType, currentLength: state.currentLength },
    });
  } else if (outcome.kind === "frozen") {
    await publishGamificationEvent(tx, {
      eventType: "StreakFrozen",
      aggregateType: "Streak",
      aggregateId: streakId,
      payload: { personId: input.personId, activityType: input.activityType, freezesRemaining: state.freezesAvailable },
    });
  } else {
    await publishGamificationEvent(tx, {
      eventType: "StreakBroken",
      aggregateType: "Streak",
      aggregateId: streakId,
      payload: {
        personId: input.personId,
        activityType: input.activityType,
        previousLength: currentState?.currentLength ?? 0,
      },
    });
  }

  return { streakId, currentLength: state.currentLength, status: state.status };
}
