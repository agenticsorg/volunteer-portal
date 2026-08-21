import type { PrismaClient } from "@prisma/client";

export interface ActiveActionsScope {
  scopeType: "org" | "chapter";
  scopeId: string | null;
}

export interface ActiveModerationActionSummary {
  actionId: string;
  actionType: "warn" | "mute" | "suspend" | "ban";
  scopeType: "org" | "chapter";
  scopeId: string | null;
  startsAt: string;
  endsAt: string | null;
}

/**
 * `getActiveActionsForPerson(personId, scope)` (docs/ddd/
 * moderation-trust-safety.md, Integration & Anti-Corruption Notes: "e.g.
 * `CreatePost`/`GiveKudos` check ... via
 * `moderation.getActiveActionsForPerson(personId, scope)`, an Open Host
 * Service read, not an event subscription, since that check must be
 * current at write time"). This is the sanctioned way another bounded
 * context (today, `community`) discovers "what sanctions currently apply
 * to this person, at this write's scope" without ever joining into
 * `moderation.moderation_action` directly.
 *
 * Returns every currently-in-effect `active` action whose own scope
 * covers `scope` — an `org`-scoped action always applies (Invariant 3: a
 * `ban` is always `org`-scoped and therefore always returned regardless
 * of `scope`'s own value); a `chapter`-scoped action applies only when
 * `scope.scopeType === 'chapter'` and its `scopeId` matches exactly
 * (mirrors a chapter-scoped moderator's own authority being confined to
 * "that Chapter's spaces/content only" — a chapter sanction never
 * restricts an org-wide write). ModerationAction invariant 5 ("the
 * effective restriction ... is the union of all currently active
 * actions, computed by the consuming context") is exactly this: the
 * caller decides which `actionType`s in the returned list actually block
 * their write (e.g. `suspend`/`ban` only, per Community's own
 * `CreatePost`/`GiveKudos` enforcement check) — this function itself does
 * not filter by `actionType`.
 *
 * Deliberately also excludes an `active` row whose `endsAt` has already
 * passed even though the hourly `ExpireModerationActions` sweep (a later
 * stage's scheduled job, not yet built) hasn't flipped its `status` to
 * `expired` yet — a write-time enforcement check must be correct now, not
 * eventually-consistent with an hourly sweep's cadence.
 */
export async function getActiveActionsForPerson(
  prisma: PrismaClient,
  personId: string,
  scope: ActiveActionsScope,
): Promise<ActiveModerationActionSummary[]> {
  const now = new Date();

  const rows = await prisma.moderationAction.findMany({
    where: {
      targetPersonId: personId,
      status: "active",
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      OR: [
        { scopeType: "org" },
        ...(scope.scopeType === "chapter" && scope.scopeId !== null
          ? [{ scopeType: "chapter" as const, scopeId: scope.scopeId }]
          : []),
      ],
    },
    orderBy: { startsAt: "desc" },
  });

  return rows.map((row) => ({
    actionId: row.id,
    actionType: row.actionType,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
  }));
}
