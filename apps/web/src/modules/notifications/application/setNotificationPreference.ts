import { type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import type { NotificationChannel, NotificationType } from "@volunteer-portal/shared";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

export interface SetNotificationPreferenceInput {
  caller: PolicySubject;
  personId: string;
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface SetPreferenceResult {
  id: string;
  enabled: boolean;
  updatedAt: string;
}

/**
 * `SetNotificationPreference` (docs/ddd/notifications.md, Key Use Case 2)
 * — upserts a `notification_preference` row (unique on
 * `personId, type, channel`). "Called from the person's own notification
 * settings page; a person may only set their own preferences (enforced by
 * `can()`, ADR-0007)" — the doc's own words, verbatim, so this is gated
 * through `can()` even though the tRPC router this later feeds would
 * already only ever pass `ctx.subject.personId` here: this is the
 * application-layer's own defense-in-depth enforcement point, not
 * something left entirely to the API layer to get right.
 */
export async function setNotificationPreference(
  prisma: PrismaClient,
  input: SetNotificationPreferenceInput,
): Promise<SetPreferenceResult> {
  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
  const allowed = can(
    input.caller,
    "notification.preference.manage",
    { type: "notification_preference", scopeType: "global", scopeId: null, ownerId: input.personId },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("notification.preference.manage");
  }

  const id = newId();
  const updatedAt = new Date();

  const row = await prisma.notificationPreference.upsert({
    where: { personId_type_channel: { personId: input.personId, type: input.type, channel: input.channel } },
    create: { id, personId: input.personId, type: input.type, channel: input.channel, enabled: input.enabled, updatedAt },
    update: { enabled: input.enabled, updatedAt },
  });

  return { id: row.id, enabled: row.enabled, updatedAt: row.updatedAt.toISOString() };
}
