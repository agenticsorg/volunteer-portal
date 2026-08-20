import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can } from "@volunteer-portal/authz";
import {
  ForbiddenActionError,
  OpenDsarRequestExistsError,
  PersonAlreadyAnonymizedError,
  PersonNotFoundError,
} from "../domain/errors";
import { getCallerPolicySubject } from "./getCallerPolicySubject";
import { listActiveRoleAssignments } from "./listActiveRoleAssignments";

/**
 * RequestErasure / AnonymizePerson (docs/ddd/identity-access.md, Key Use
 * Case 7).
 *
 * *Pre:* No other `pending`/`processing` `erasure` request exists for
 * this `personId`.
 *
 * *Post:* A `DSARRequest(type='erasure')` row is created and driven
 * through `processing → completed`; on completion: `Person.status =
 * 'anonymized'`, `email`/`displayName`/`bio`/`avatarUrl`/`dateOfBirth`
 * are overwritten with an irreversible placeholder, `anonymizedAt` is
 * set, `PersonAnonymized` is emitted, and `recordAuditEvent()` tags the
 * outbox write `audit: true`. Aggregate facts this context or others
 * hold about the Person are preserved — this is never a cascade delete
 * (no other bounded context exists yet to fan out to this phase; each
 * later context implements its own anonymization against
 * `PersonAnonymized`, per the doc's Integration Notes).
 *
 * All three steps — the `DSARRequest` row, `Person` anonymization, and
 * both domain events — commit in one transaction (invariant 2: "these two
 * facts are made consistent in the same transaction as the status
 * transition"). No async job is used (see `requestDataExport.ts`'s file
 * header for the same reasoning): anonymizing a single-schema `Person`
 * row is fast enough to do synchronously, and doing so keeps the
 * "erasure reaching `completed` implies anonymized" invariant trivially
 * true instead of racy.
 *
 * Also revokes, in the same transaction, every `RoleAssignment` the
 * erased person still holds actively (`RoleAssignment` invariant 3:
 * revocation is a state change — `revokedBy`/`revokedAt` set, never a
 * delete — same pattern `revokeRole.ts` uses). Without this, an
 * anonymized former `org_admin` would keep a fully active `org_admin`
 * `RoleAssignment` indefinitely; `can()`'s own caller-status check
 * (`packages/authz/src/can.ts`) already stops that account from
 * *exercising* privileged authority once anonymized, but the stale
 * active grant would still be visible to anyone reading this person's
 * role history and would resurface as live authority again if that
 * status check were ever weakened — belt-and-suspenders, not redundant.
 */
export interface RequestErasureInput {
  personId: string;
  requestedBy: string;
}

export interface ErasureResult {
  dsarId: string;
  anonymizedAt: string;
}

const ANONYMIZED_DISPLAY_NAME = "Deleted User";

function anonymizedEmailFor(personId: string): string {
  return `anonymized+${personId.toLowerCase()}@volunteer-portal.invalid`;
}

export async function requestErasure(
  prisma: PrismaClient,
  input: RequestErasureInput,
): Promise<ErasureResult> {
  const [requesterSubject, requesterAssignments] = await Promise.all([
    getCallerPolicySubject(prisma, input.requestedBy, "dsar.erasure.request"),
    listActiveRoleAssignments(prisma, input.requestedBy),
  ]);
  const allowed = can(
    requesterSubject,
    "dsar.erasure.request",
    { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: input.personId },
    requesterAssignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("dsar.erasure.request");
  }

  const person = await prisma.person.findUnique({
    where: { id: input.personId },
    select: { status: true },
  });
  if (!person) throw new PersonNotFoundError(input.personId);
  if (person.status === "anonymized") throw new PersonAlreadyAnonymizedError(input.personId);

  const openRequest = await prisma.dSARRequest.findFirst({
    where: { personId: input.personId, type: "erasure", status: { in: ["pending", "processing"] } },
    select: { id: true },
  });
  if (openRequest) throw new OpenDsarRequestExistsError(input.personId, "erasure");

  const dsarId = newId();
  const anonymizedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const created = await tx.dSARRequest.create({
      data: { id: dsarId, personId: input.personId, type: "erasure", status: "pending", requestedBy: input.requestedBy },
      select: { id: true, personId: true, requestedAt: true },
    });

    await tx.identityDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "DSARRequest",
        aggregateId: created.id,
        eventType: "DSARRequested",
        payload: {
          dsarId: created.id,
          personId: created.personId,
          type: "erasure",
          requestedAt: created.requestedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await tx.dSARRequest.update({ where: { id: dsarId }, data: { status: "processing" } });

    await tx.person.update({
      where: { id: input.personId },
      data: {
        email: anonymizedEmailFor(input.personId),
        displayName: ANONYMIZED_DISPLAY_NAME,
        bio: null,
        avatarUrl: null,
        dateOfBirth: null,
        status: "anonymized",
        anonymizedAt,
      },
    });

    await tx.dSARRequest.update({
      where: { id: dsarId },
      data: { status: "completed", completedAt: anonymizedAt },
    });

    // Revoke (never delete) every RoleAssignment this person still holds
    // actively — same transaction, so a crash between the person update
    // and this one can never leave a stale active grant behind (Person
    // invariant 3's terminality and RoleAssignment invariant 3's
    // never-delete rule both hold together or not at all).
    await tx.roleAssignment.updateMany({
      where: { subjectId: input.personId, revokedAt: null },
      data: { revokedBy: input.requestedBy, revokedAt: anonymizedAt },
    });

    await tx.identityDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Person",
        aggregateId: input.personId,
        eventType: "PersonAnonymized",
        payload: {
          personId: input.personId,
          anonymizedAt: anonymizedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.identityDomainEvent, {
      actorId: input.requestedBy,
      actorType: "user",
      action: "person.anonymize",
      resourceType: "person",
      resourceId: input.personId,
      metadata: { dsarId: created.id },
    });
  });

  return { dsarId, anonymizedAt: anonymizedAt.toISOString() };
}
