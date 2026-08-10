import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can } from "@volunteer-portal/authz";
import { ForbiddenActionError, OpenDsarRequestExistsError, PersonNotFoundError } from "../domain/errors";
import { listActiveRoleAssignments } from "./listActiveRoleAssignments";
import { writeExportBundle } from "@/server/dsar/exportStorage";
import { signExportToken } from "@/server/dsar/signing";

/**
 * RequestDataExport (docs/ddd/identity-access.md, Key Use Case 6).
 *
 * *Pre:* No other `pending`/`processing` `export` request exists for this
 * `personId`.
 *
 * *Post:* A `DSARRequest(type='export', status='pending')` row exists;
 * `DSARRequested` is emitted; the request is then driven to
 * `completed` with a signed `exportFileUrl`.
 *
 * The doc describes this as an async `graphile-worker` job assembling the
 * export; this phase runs `processExport` synchronously, in-process,
 * right after the request row commits — see `@/server/dsar/exportStorage`'s
 * file header for why (no other bounded context exists yet to fan out to,
 * and no cloud storage is provisioned this phase). The `DSARRequest`
 * state machine (`pending → processing → completed | failed`) is
 * unaffected by this choice — lifting `processExport` into a real
 * graphile-worker task later is a call-site change only.
 */
export interface RequestDataExportInput {
  personId: string;
  requestedBy: string;
}

export interface RequestedDataExport {
  dsarId: string;
}

export async function requestDataExport(
  prisma: PrismaClient,
  input: RequestDataExportInput,
): Promise<RequestedDataExport> {
  const requesterAssignments = await listActiveRoleAssignments(prisma, input.requestedBy);
  const allowed = can(
    { id: input.requestedBy },
    "dsar.export.request",
    { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: input.personId },
    requesterAssignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("dsar.export.request");
  }

  const person = await prisma.person.findUnique({ where: { id: input.personId }, select: { id: true } });
  if (!person) throw new PersonNotFoundError(input.personId);

  const openRequest = await prisma.dSARRequest.findFirst({
    where: { personId: input.personId, type: "export", status: { in: ["pending", "processing"] } },
    select: { id: true },
  });
  if (openRequest) throw new OpenDsarRequestExistsError(input.personId, "export");

  const dsarId = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.dSARRequest.create({
      data: { id: dsarId, personId: input.personId, type: "export", status: "pending", requestedBy: input.requestedBy },
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
          type: "export",
          requestedAt: created.requestedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.identityDomainEvent, {
      actorId: input.requestedBy,
      actorType: "user",
      action: "dsar.export.request",
      resourceType: "dsar_request",
      resourceId: created.id,
      metadata: { personId: input.personId, type: "export" },
    });
  });

  await processExport(prisma, dsarId, input.personId, input.requestedBy);

  return { dsarId };
}

async function processExport(
  prisma: PrismaClient,
  dsarId: string,
  personId: string,
  requestedBy: string,
): Promise<void> {
  await prisma.dSARRequest.update({ where: { id: dsarId }, data: { status: "processing" } });

  try {
    const bundle = await assembleExportBundle(prisma, personId, requestedBy);
    await writeExportBundle(dsarId, bundle);
    const token = signExportToken(dsarId, personId);
    const exportFileUrl = `/api/v1/persons/${personId}/dsar-export?token=${token}`;

    await prisma.dSARRequest.update({
      where: { id: dsarId },
      data: { status: "completed", completedAt: new Date(), exportFileUrl },
    });
  } catch (error) {
    await prisma.dSARRequest.update({
      where: { id: dsarId },
      data: { status: "failed", failureReason: error instanceof Error ? error.message : "Unknown error" },
    });
    throw error;
  }
}

/**
 * Assembles this bounded context's own data about `personId` (the only
 * context that exists this phase — per-context `export_subject_data`
 * fan-out, ADR-0014's Implementation Notes, is deferred until other
 * contexts exist to fan out to).
 *
 * ADR-0014's Storing-DOB note: "mask DOB to year-only unless the
 * requester is the subject themselves authenticated" — `dateOfBirth` is
 * included in full only when `requestedBy === personId`; an org_admin
 * exporting on someone else's behalf gets it masked to year-only.
 */
async function assembleExportBundle(prisma: PrismaClient, personId: string, requestedBy: string) {
  const person = await prisma.person.findUniqueOrThrow({ where: { id: personId } });
  const [roleAssignments, consentRecords, dsarRequests] = await Promise.all([
    prisma.roleAssignment.findMany({ where: { subjectId: personId } }),
    prisma.consentRecord.findMany({ where: { personId } }),
    prisma.dSARRequest.findMany({ where: { personId } }),
  ]);

  const selfRequested = requestedBy === personId;

  return {
    exportedAt: new Date().toISOString(),
    person: {
      id: person.id,
      publicSlug: person.publicSlug,
      email: person.email,
      displayName: person.displayName,
      pronouns: person.pronouns,
      avatarUrl: person.avatarUrl,
      bio: person.bio,
      dateOfBirth: selfRequested
        ? (person.dateOfBirth?.toISOString().slice(0, 10) ?? null)
        : (person.dateOfBirth ? String(person.dateOfBirth.getUTCFullYear()) : null),
      ageAttested16Plus: person.ageAttested16Plus,
      primaryChapterId: person.primaryChapterId,
      status: person.status,
      createdAt: person.createdAt.toISOString(),
    },
    roleAssignments,
    consentRecords,
    dsarRequests,
  };
}
