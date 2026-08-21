import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { publishGamificationEvent } from "./publishGamificationEvent";

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";
const SAVEPOINT_NAME = "record_points_for_event";

export type SourceEventType = "HoursApproved" | "ModuleCompleted" | "CourseCompleted" | "ManualAdjustment";

export interface RecordPointsForEventInput {
  personId: string;
  /** Signed — a negative value is a compensating correction, never a mutation of a prior row. */
  points: number;
  sourceEventType: SourceEventType;
  /** The originating event's own id; for `ManualAdjustment` a freshly generated id (Key Use Case 9 has no external event to key off). */
  sourceEventId: string;
  /** Required (app-enforced) for `ManualAdjustment` — see `adminAdjustPoints.ts`. */
  reason?: string;
}

export interface RecordPointsForEventResult {
  ledgerEntryId: string;
  totalPoints: bigint;
  /** `false` when `PointsLedgerEntry`'s own `(sourceEventType, sourceEventId)` unique constraint caught a redelivery this call's caller had already checked via `processed_events` — a second, independent idempotency backstop (docs/ddd/gamification.md, PointsLedgerEntry invariant 2). */
  inserted: boolean;
}

/**
 * RecordPointsForEvent (docs/ddd/gamification.md, Key Use Case 2): inserts a
 * `PointsLedgerEntry`, updates `PointsBalance` incrementally in the same
 * transaction, and publishes `PointsAwarded` when `points > 0` (a
 * `ManualAdjustment` correction can be negative, per that event's own "Emitted
 * When" clause). Must be called from *inside* the caller's own
 * `prisma.$transaction` — same "runs inside the caller's transaction" shape
 * as `training`'s `evaluateModuleAndCourseCompletion`.
 *
 * The `(sourceEventType, sourceEventId)` duplicate check still catches
 * Prisma's `create()` throwing P2002 (unlike `awardBadge.ts`'s `badge_award`
 * insert, this table cannot use `INSERT ... ON CONFLICT` at all — Postgres
 * rejects `ON CONFLICT` outright on any table that has a rule, and this one
 * has the append-only `points_ledger_no_update`/`points_ledger_no_delete`
 * rules from the Schema Sketch: `ERROR: INSERT with ON CONFLICT clause
 * cannot be used with table that has INSERT or UPDATE rules`). A bare
 * catch would still leave the surrounding Postgres transaction aborted
 * (`25P02`) after the duplicate-key error, breaking this backstop's own
 * follow-up read (`pointsBalance`) and every statement a caller runs
 * afterwards in the same `prisma.$transaction` (`updateStreak`,
 * `evaluateBadgeCriteria`) — so the `create()` is wrapped in its own
 * `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`, the standard Postgres idiom for
 * recovering from an expected, caught error mid-transaction without
 * aborting the whole thing.
 */
export async function recordPointsForEvent(
  tx: Prisma.TransactionClient,
  input: RecordPointsForEventInput,
): Promise<RecordPointsForEventResult> {
  const ledgerEntryId = newId();

  await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    await tx.pointsLedgerEntry.create({
      data: {
        id: ledgerEntryId,
        personId: input.personId,
        points: input.points,
        sourceEventType: input.sourceEventType,
        sourceEventId: input.sourceEventId,
        reason: input.reason ?? null,
      },
    });
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
      const balance = await tx.pointsBalance.findUnique({ where: { personId: input.personId } });
      return { ledgerEntryId, totalPoints: balance?.totalPoints ?? BigInt(0), inserted: false };
    }
    throw error;
  }

  const balance = await tx.pointsBalance.upsert({
    where: { personId: input.personId },
    create: { personId: input.personId, totalPoints: input.points, lastLedgerEntryId: ledgerEntryId },
    update: { totalPoints: { increment: input.points }, lastLedgerEntryId: ledgerEntryId },
  });

  if (input.points > 0) {
    await publishGamificationEvent(tx, {
      eventType: "PointsAwarded",
      aggregateType: "PointsLedgerEntry",
      aggregateId: ledgerEntryId,
      payload: {
        personId: input.personId,
        points: input.points,
        ledgerEntryId,
        sourceEventType: input.sourceEventType,
      },
    });
  }

  return { ledgerEntryId, totalPoints: balance.totalPoints, inserted: true };
}
