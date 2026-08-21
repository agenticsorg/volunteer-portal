import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { getPersonSummary, listActiveRoleAssignments } from "@/modules/identity";
import {
  BanMustBeOrgScopedError,
  InvalidDurationForActionTypeError,
  InvalidScopeError,
  OutOfScopeError,
  PersonNotFoundError,
} from "../domain/errors";
import { publishModerationEvent } from "./publishModerationEvent";

export type ModerationActionType = "warn" | "mute" | "suspend" | "ban";

export interface TakeModerationActionInput {
  caller: PolicySubject;
  targetPersonId: string;
  actionType: ModerationActionType;
  reason: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  /**
   * Required for `mute`/`suspend` — must be present (a future ISO
   * timestamp, or explicitly `null` for an indefinite sanction). Must be
   * omitted (`undefined`) for `warn`/`ban`, which never carry a duration.
   * ModerationAction invariant 2: "the choice must be explicit, not
   * defaulted silently."
   */
  endsAt?: string | null;
  relatedReportId?: string;
}

export interface TakenModerationAction {
  actionId: string;
}

function assertValidScope(scopeType: "org" | "chapter", scopeId: string | null): void {
  const scopeIdRequired = scopeType === "chapter";
  if (scopeIdRequired !== (scopeId !== null)) {
    throw new InvalidScopeError(
      scopeIdRequired
        ? "A chapter-scoped moderation action must carry a scopeId."
        : "An org-scoped moderation action must not carry a scopeId.",
    );
  }
}

function assertValidDuration(actionType: ModerationActionType, endsAt: string | null | undefined): void {
  if (actionType === "warn" || actionType === "ban") {
    if (endsAt !== undefined && endsAt !== null) {
      throw new InvalidDurationForActionTypeError(`A "${actionType}" must not carry an endsAt (it is never time-boxed).`);
    }
    return;
  }
  // mute / suspend
  if (endsAt === undefined) {
    throw new InvalidDurationForActionTypeError(
      `A "${actionType}" requires endsAt to be explicitly set — a future timestamp for a bounded sanction, or ` +
        "null for an indefinite one pending manual review. It cannot be omitted.",
    );
  }
  if (endsAt !== null) {
    const parsed = new Date(endsAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw new InvalidDurationForActionTypeError(`A "${actionType}"'s endsAt must be a future timestamp, or null.`);
    }
  }
}

/**
 * TakeModerationAction (docs/ddd/moderation-trust-safety.md, Key Use Case
 * 4). Validates the acting moderator's scope authority
 * (`moderation_action.take`, ADR-0007) and the duration invariants for the
 * given `actionType` (invariants 1–2), persists the `ModerationAction`,
 * optionally links `relatedReportId`, emits `ModerationActionTaken`.
 *
 * ModerationAction invariant 3 (second half — "a `ban` is ALWAYS
 * org-scoped regardless of where the report originated") is enforced
 * explicitly here, BEFORE the `can()` scope-authority check runs: a
 * `ban` request carrying `scopeType: 'chapter'` is rejected outright
 * rather than silently coerced to `org`, since `can()` itself has no
 * notion of `actionType` and would otherwise happily authorize a
 * chapter-scoped moderator to issue a chapter-scoped "ban" that the DB's
 * own `chk_moderation_action_ban_org` CHECK would then reject anyway —
 * better to fail with a clear domain error at the use-case boundary.
 */
export async function takeModerationAction(
  prisma: PrismaClient,
  input: TakeModerationActionInput,
): Promise<TakenModerationAction> {
  assertValidScope(input.scopeType, input.scopeId);
  if (input.actionType === "ban" && input.scopeType !== "org") {
    throw new BanMustBeOrgScopedError();
  }
  assertValidDuration(input.actionType, input.endsAt);

  const target = await getPersonSummary(prisma, input.targetPersonId);
  if (!target) {
    throw new PersonNotFoundError(input.targetPersonId);
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "moderation_action.take",
    { type: "moderation_action", scopeType: input.scopeType === "org" ? "global" : "chapter", scopeId: input.scopeId },
    assignments,
  );
  if (!allowed) {
    throw new OutOfScopeError("moderation_action.take");
  }

  const actionId = newId();
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;

  await prisma.$transaction(async (tx) => {
    await tx.moderationAction.create({
      data: {
        id: actionId,
        actionType: input.actionType,
        targetPersonId: input.targetPersonId,
        moderatorPersonId: input.caller.id,
        reason: input.reason,
        relatedReportId: input.relatedReportId ?? null,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        endsAt,
      },
    });

    await publishModerationEvent(tx, {
      eventType: "ModerationActionTaken",
      aggregateType: "ModerationAction",
      aggregateId: actionId,
      payload: {
        actionId,
        actionType: input.actionType,
        targetPersonId: input.targetPersonId,
        moderatorPersonId: input.caller.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        endsAt: endsAt ? endsAt.toISOString() : null,
      } satisfies Prisma.InputJsonValue,
    });

    await recordAuditEvent(tx.moderationDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: `moderation.action_taken.${input.actionType}`,
      resourceType: "moderation_action",
      resourceId: actionId,
      scopeType: input.scopeType === "org" ? "global" : "chapter",
      scopeId: input.scopeId ?? undefined,
      metadata: { targetPersonId: input.targetPersonId, actionType: input.actionType, relatedReportId: input.relatedReportId ?? null },
    });
  });

  return { actionId };
}
