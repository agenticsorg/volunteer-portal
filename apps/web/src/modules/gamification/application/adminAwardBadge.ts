import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary } from "@/modules/identity";
import { BadgeNotFoundError, PersonNotFoundError } from "../domain/errors";
import { assertGamificationAuthority } from "./assertGamificationAuthority";
import { awardBadge } from "./awardBadge";

export interface AdminAwardBadgeInput {
  caller: PolicySubject;
  personId: string;
  badgeId: string;
}

export interface AdminAwardBadgeResult {
  badgeAwardId: string | null;
  alreadyAwarded: boolean;
}

/**
 * `adminAwardBadge` (docs/ddd/gamification.md's API Contract Sketch,
 * `adminProcedure`) — a staff-granted `BadgeAward` outside the normal
 * criteria-evaluation path (e.g. a manually-recognized contribution).
 * Gated by `can(caller, "badge.award", ...)` (org-wide — see
 * `assertGamificationAuthority.ts`); reuses `awardBadge`'s own idempotent
 * insert (`(personId, badgeId)` uniqueness — re-awarding is a no-op, not an
 * error), and audits the privileged action in the same transaction.
 */
export async function adminAwardBadge(
  prisma: PrismaClient,
  input: AdminAwardBadgeInput,
): Promise<AdminAwardBadgeResult> {
  await assertGamificationAuthority(prisma, input.caller, "badge.award");

  const target = await getPersonSummary(prisma, input.personId);
  if (!target) {
    throw new PersonNotFoundError(input.personId);
  }

  const badge = await prisma.badge.findUnique({ where: { id: input.badgeId }, select: { id: true } });
  if (!badge) {
    throw new BadgeNotFoundError(input.badgeId);
  }

  return prisma.$transaction(async (tx) => {
    const result = await awardBadge(tx, { personId: input.personId, badgeId: input.badgeId, sourceEventId: null });

    await recordAuditEvent(tx.gamificationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "badge.award",
      resourceType: "badge_award",
      resourceId: result.badgeAwardId ?? input.badgeId,
      scopeType: "global",
      metadata: { personId: input.personId, badgeId: input.badgeId, alreadyAwarded: !result.awarded },
    });

    return { badgeAwardId: result.badgeAwardId, alreadyAwarded: !result.awarded };
  });
}
