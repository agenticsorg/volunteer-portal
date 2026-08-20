import { Prisma, type PrismaClient } from "@prisma/client";
import type { IdentityConsentPurpose } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { NoActiveConsentError } from "../domain/errors";

/**
 * RevokeConsent (docs/ddd/identity-access.md, Key Use Case 5).
 *
 * *Pre:* An active (non-revoked) `ConsentRecord` exists for
 * `(personId, purpose)`.
 *
 * *Post:* `revokedAt` is set on that row; `ConsentRevoked` is emitted.
 */
export interface RevokeConsentInput {
  personId: string;
  purpose: IdentityConsentPurpose;
  /** Who performed the revocation, for the audit trail — defaults to `personId` (self-service). */
  revokedBy?: string;
}

export async function revokeConsent(prisma: PrismaClient, input: RevokeConsentInput): Promise<void> {
  // "Current consent" for a purpose is the most recent non-revoked row
  // (invariant 2 — a new decision is always a new row).
  const current = await prisma.consentRecord.findFirst({
    where: { personId: input.personId, purpose: input.purpose, revokedAt: null },
    orderBy: { recordedAt: "desc" },
    select: { id: true },
  });
  if (!current) {
    throw new NoActiveConsentError(input.personId, input.purpose);
  }

  const revokedBy = input.revokedBy ?? input.personId;

  try {
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.consentRecord.update({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date() },
        select: { id: true, personId: true, purpose: true, revokedAt: true },
      });

      await tx.identityDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "ConsentRecord",
          aggregateId: revoked.id,
          eventType: "ConsentRevoked",
          payload: {
            consentId: revoked.id,
            personId: revoked.personId,
            purpose: revoked.purpose,
            revokedAt: revoked.revokedAt!.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: revokedBy,
        actorType: "user",
        action: "consent.revoke",
        resourceType: "consent_record",
        resourceId: revoked.id,
        metadata: { personId: revoked.personId, purpose: revoked.purpose },
      });
    });
  } catch (error) {
    // Revoked by a concurrent request between our read and this update.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new NoActiveConsentError(input.personId, input.purpose);
    }
    throw error;
  }
}
