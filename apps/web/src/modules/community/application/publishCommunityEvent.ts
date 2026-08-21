import { Prisma } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { attachRequestMetadata, getRequestId } from "@volunteer-portal/observability";

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
 *
 * ADR-0013 §"Correlation": stamps the current request's `requestId` (see
 * `requestContext.ts`) onto `payload._meta.requestId` before writing, so a
 * graphile-worker job later draining this row can log the originating
 * request. A no-op when there is no current request context (e.g. this is
 * called from a script or a test outside `runWithRequestContext`).
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
      payload: attachRequestMetadata(event.payload, getRequestId()),
    },
  });
}
