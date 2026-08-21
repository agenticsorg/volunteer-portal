import type { PrismaClient } from "@prisma/client";
import { getPersonSummary } from "@/modules/identity";
import { getOpportunityById } from "@/modules/volunteering";
import type { HoursApprovedPayload } from "../../../domain/inboundEvents";
import { PersonNotFoundError, SourceRecordNotFoundError } from "../../../domain/errors";
import { queueNotification } from "../../queueNotification";
import { recordProcessedEventAndHandle, type ConsumptionResult } from "../../idempotentConsumption";

function formatHours(durationMinutes: number): number {
  return Math.round((durationMinutes / 60) * 10) / 10;
}

/**
 * `HandleHoursApproved` (docs/ddd/notifications.md's Integration &
 * Anti-Corruption Notes) — mirrors `volunteering`'s `HoursApproved`
 * producer (`application/approveHours.ts`). That producer's payload does
 * not itself carry the Opportunity's `title` (only `opportunityId`), so
 * this handler resolves it via `volunteering.getOpportunityById` (the
 * sanctioned Open Host Service read) — using the plain `prisma` client,
 * BEFORE the idempotency-ledger transaction opens, same "cross-context
 * reads need a plain `PrismaClient`, not a `Prisma.TransactionClient`"
 * shape `community`'s own `handleHoursApproved.ts` already established for
 * this identical payload.
 *
 * Recipient: `payload.personId` (the volunteer whose hours were approved).
 * Requested channels: both — `hours_approved` is an operational/
 * transactional type (docs/ddd/notifications.md's `NotificationPreference`
 * default-behavior paragraph), so it's requested on every channel and the
 * QUEUE-TIME gate inside `queueNotification` narrows it down from there.
 */
export async function handleHoursApproved(
  prisma: PrismaClient,
  payload: HoursApprovedPayload,
  sourceEventId: string,
): Promise<ConsumptionResult> {
  const [person, opportunity] = await Promise.all([
    getPersonSummary(prisma, payload.personId),
    getOpportunityById(prisma, payload.opportunityId),
  ]);
  if (!person) {
    throw new PersonNotFoundError(payload.personId);
  }
  if (!opportunity) {
    throw new SourceRecordNotFoundError("volunteering.opportunity", payload.opportunityId);
  }

  const hours = formatHours(payload.durationMinutes);

  return recordProcessedEventAndHandle(
    prisma,
    { id: sourceEventId, sourceContext: "volunteering", eventType: "HoursApproved" },
    async (tx) => {
      await queueNotification(tx, {
        recipientPersonId: payload.personId,
        type: "hours_approved",
        requestedChannels: ["email", "in_app"],
        sourceContext: "volunteering",
        sourceEventId,
        payload: { hourEntryId: payload.hourEntryId, hours, opportunityTitle: opportunity.title },
      });
    },
  );
}
