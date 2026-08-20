import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { IdentityConsentPurpose } from "@prisma/client";
import { IncompleteGuardianConsentError, PersonNotActiveError, PersonNotFoundError } from "../domain/errors";

/**
 * RecordConsent (docs/ddd/identity-access.md, Key Use Case 4).
 *
 * *Pre:* `personId` refers to an active Person; if
 * `purpose = 'guardian_consent'`, `guardianName`/`guardianEmail` are
 * supplied.
 *
 * *Post:* A new `ConsentRecord` row exists (never an update to a prior
 * one — invariant 2); `ConsentRecorded` is emitted.
 */
export type ConsentSource = "signup_form" | "settings_page" | "guardian_form" | "admin_override";

export interface RecordConsentInput {
  personId: string;
  purpose: IdentityConsentPurpose;
  granted: boolean;
  policyVersion: string;
  source: ConsentSource;
  guardianName?: string;
  guardianEmail?: string;
}

export interface RecordedConsent {
  consentId: string;
}

export async function recordConsent(
  prisma: PrismaClient,
  input: RecordConsentInput,
): Promise<RecordedConsent> {
  if (input.purpose === "guardian_consent" && (!input.guardianName || !input.guardianEmail)) {
    throw new IncompleteGuardianConsentError();
  }

  const person = await prisma.person.findUnique({
    where: { id: input.personId },
    select: { status: true },
  });
  if (!person) throw new PersonNotFoundError(input.personId);
  if (person.status !== "active") throw new PersonNotActiveError(input.personId);

  const consentId = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.consentRecord.create({
      data: {
        id: consentId,
        personId: input.personId,
        purpose: input.purpose,
        granted: input.granted,
        policyVersion: input.policyVersion,
        source: input.source,
        guardianName: input.guardianName ?? null,
        guardianEmail: input.guardianEmail ?? null,
      },
      select: { id: true, personId: true, purpose: true, granted: true, policyVersion: true, source: true, recordedAt: true },
    });

    await tx.identityDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "ConsentRecord",
        aggregateId: created.id,
        eventType: "ConsentRecorded",
        payload: {
          consentId: created.id,
          personId: created.personId,
          purpose: created.purpose,
          granted: created.granted,
          policyVersion: created.policyVersion,
          source: created.source,
          recordedAt: created.recordedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    // Ubiquitous Language "Audit Log" row: consent change is one of this
    // context's privileged actions recorded via recordAuditEvent().
    await recordAuditEvent(tx.identityDomainEvent, {
      actorId: input.personId,
      actorType: "user",
      action: "consent.record",
      resourceType: "consent_record",
      resourceId: created.id,
      metadata: { personId: input.personId, purpose: input.purpose, granted: input.granted },
    });
  });

  return { consentId };
}
