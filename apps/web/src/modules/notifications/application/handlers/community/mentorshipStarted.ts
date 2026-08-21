import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import type { MentorshipStartedPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

/**
 * `HandleMentorshipStarted` — mirrors `community`'s `MentorshipStarted`
 * producer (`application/acceptMentorship.ts`).
 *
 * Recipient: BOTH parties. A mentorship starting is news either the mentor
 * or the mentee would reasonably want to know about, and each side's copy
 * needs the *other* party's name — so this queues two independent
 * `Notification`s from the one source event, one per recipient. This is
 * exactly what `Notification`'s own idempotency shape supports: the unique
 * index is `(sourceEventId, recipientPersonId)`, not `sourceEventId`
 * alone, so two different recipients for the same event never collide.
 * `queueNotification` itself is called twice here inside the SAME
 * idempotency-ledger transaction (`notifications.processed_events` is
 * still keyed by the bare event id, so this whole handler — both queue
 * calls — runs at most once per source event, exactly like every other
 * handler in this module).
 */
export async function handleMentorshipStarted(
  prisma: PrismaClient,
  payload: MentorshipStartedPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const [mentor, mentee] = await Promise.all([
    getPersonSummary(prisma, payload.mentorPersonId),
    getPersonSummary(prisma, payload.menteePersonId),
  ]);
  if (!mentor) throw new PersonNotFoundError(payload.mentorPersonId);
  if (!mentee) throw new PersonNotFoundError(payload.menteePersonId);

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "community", eventType: "MentorshipStarted" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.menteePersonId,
        type: "mentorship_started",
        requestedChannels: ["email", "in_app"],
        sourceContext: "community",
        sourceEventId,
        payload: { mentorshipId: payload.mentorshipId, counterpartDisplayName: mentor.displayName },
      });
      await queueNotification(tx, {
        recipientPersonId: payload.mentorPersonId,
        type: "mentorship_started",
        requestedChannels: ["email", "in_app"],
        sourceContext: "community",
        sourceEventId,
        payload: { mentorshipId: payload.mentorshipId, counterpartDisplayName: mentee.displayName },
      });
    },
  );
}
