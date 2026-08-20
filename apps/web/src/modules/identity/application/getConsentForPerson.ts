import type { IdentityConsentPurpose, PrismaClient } from "@prisma/client";

/**
 * The `identity-access-schema-api.md` contract's `consent.getForPerson`
 * read shape: "`ConsentRecord[]` (current state per purpose)". A
 * `ConsentRecord` row is never updated in place (RecordConsent/
 * RevokeConsent invariant 2 — "a new decision is always a new row"), so
 * "current state" means the single most recent row per `purpose`, which
 * may itself be revoked (withdrawn consent is still the current state).
 */
export interface CurrentConsentRecord {
  consentId: string;
  purpose: IdentityConsentPurpose;
  granted: boolean;
  policyVersion: string;
  source: string;
  recordedAt: string;
  revokedAt: string | null;
}

export async function getConsentForPerson(
  prisma: PrismaClient,
  personId: string,
): Promise<CurrentConsentRecord[]> {
  const records = await prisma.consentRecord.findMany({
    where: { personId },
    orderBy: { recordedAt: "desc" },
  });

  const seenPurposes = new Set<IdentityConsentPurpose>();
  const current: CurrentConsentRecord[] = [];

  for (const record of records) {
    if (seenPurposes.has(record.purpose)) continue;
    seenPurposes.add(record.purpose);
    current.push({
      consentId: record.id,
      purpose: record.purpose,
      granted: record.granted,
      policyVersion: record.policyVersion,
      source: record.source,
      recordedAt: record.recordedAt.toISOString(),
      revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    });
  }

  return current;
}
