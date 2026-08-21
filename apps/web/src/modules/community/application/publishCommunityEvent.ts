import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";

/**
 * Writes one row to this context's own transactional outbox
 * (`community.domain_events`, ADR-0009) — always called from *inside* the
 * same `prisma.$transaction` as the state change it announces, same "write
 * the event in the same transaction as the write it describes" shape as
 * every other module's own `publish*Event` helper (e.g. `gamification`'s
 * `publishGamificationEvent.ts`). Downstream, `notifications` (and, for
 * `KudosGiven`, `gamification`'s optional small point award) drain this
 * table for `PostCreated`, `KudosGiven`, `TeamCreated`, `TeamJoined`,
 * `MentorshipRequested`, `MentorshipStarted` — a future infra-layer worker
 * task's job, not this stage's.
 */
export interface CommunityEventInput {
  eventType: "PostCreated" | "KudosGiven" | "TeamCreated" | "TeamJoined" | "MentorshipRequested" | "MentorshipStarted";
  aggregateType: "Post" | "Kudos" | "Team" | "TeamMembership" | "Mentorship";
  aggregateId: string;
  payload: Prisma.InputJsonValue;
}

export async function publishCommunityEvent(
  tx: Prisma.TransactionClient,
  event: CommunityEventInput,
): Promise<void> {
  await tx.communityDomainEvent.create({
    data: {
      id: newId(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
    },
  });
}
