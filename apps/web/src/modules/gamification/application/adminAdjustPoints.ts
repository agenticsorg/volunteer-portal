import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import { ManualAdjustmentReasonRequiredError, PersonNotFoundError } from "../domain/errors";
import { assertGamificationAuthority } from "./assertGamificationAuthority";
import { recordPointsForEvent } from "./recordPointsForEvent";

export interface AdminAdjustPointsInput {
  caller: PolicySubject;
  personId: string;
  /** Signed — positive to award, negative to correct/claw back. */
  points: number;
  reason: string;
}

export interface AdminAdjustPointsResult {
  ledgerEntryId: string;
}

/**
 * AdminAdjustPoints (docs/ddd/gamification.md, Key Use Case 9): "staff-only
 * escape hatch that inserts a `ManualAdjustment` `PointsLedgerEntry`
 * (positive or negative) with a required `reason`, for corrections — never
 * edits or removes existing rows." Gated by `can(caller, "points.adjust",
 * ...)` (org-wide — see `assertGamificationAuthority.ts`); the privileged
 * action is audited via `recordAuditEvent` in the same transaction, same
 * "gate, act, audit — all one transaction" shape every other module's
 * staff-only mutation uses.
 */
export async function adminAdjustPoints(
  prisma: PrismaClient,
  input: AdminAdjustPointsInput,
): Promise<AdminAdjustPointsResult> {
  if (!input.reason.trim()) {
    throw new ManualAdjustmentReasonRequiredError();
  }

  await assertGamificationAuthority(prisma, input.caller, "points.adjust");

  const target = await getPersonSummary(prisma, input.personId);
  if (!target) {
    throw new PersonNotFoundError(input.personId);
  }

  return prisma.$transaction(async (tx) => {
    const { ledgerEntryId } = await recordPointsForEvent(tx, {
      personId: input.personId,
      points: input.points,
      sourceEventType: "ManualAdjustment",
      sourceEventId: newId(),
      reason: input.reason,
    });

    await recordAuditEvent(tx.gamificationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "points.adjust",
      resourceType: "points_ledger_entry",
      resourceId: ledgerEntryId,
      scopeType: "global",
      metadata: { personId: input.personId, points: input.points, reason: input.reason },
    });

    return { ledgerEntryId };
  });
}
