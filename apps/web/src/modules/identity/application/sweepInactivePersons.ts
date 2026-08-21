import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";

const ANONYMIZED_DISPLAY_NAME = "Deleted User";

function anonymizedEmailFor(personId: string): string {
  return `anonymized+${personId.toLowerCase()}@volunteer-portal.invalid`;
}

export interface SweepInactivePersonsResult {
  anonymizedCount: number;
}

/**
 * `identity.sweepInactivePersons(cutoff)` — the `inactive_volunteer_pii`
 * data class's owning-schema cleanup function (ADR-0014 §3: "730 days
 * since last login -> anonymize"), invoked directly by `admin`'s
 * `retention_sweep` job and exported through this module's own `index.ts`
 * (ADR-0001) — never a generic cross-schema `UPDATE`.
 *
 * `identity.persons` has no `last_login_at` column — this codebase's
 * session/login timestamps are owned entirely by Supabase Auth, outside
 * this Prisma schema's reach (same boundary `docs/adr/0014-...md`'s own
 * age-gating section implicitly assumes when it defers encryption to
 * "Neon/Supabase" managed infrastructure). `updated_at` is used as the
 * documented substitute — the same kind of deliberate, explicitly-noted
 * substitution this codebase already makes elsewhere for missing
 * infrastructure (local disk instead of R2 in `requestDataExport.ts`,
 * synchronous instead of async DSAR jobs) rather than fabricating a
 * `last_login_at` column this phase has no real way to populate.
 *
 * Reuses `requestErasure.ts`'s own anonymization shape exactly (same
 * placeholder email/display name, same active-role-assignment revocation,
 * same `PersonAnonymized` event) — this sweep is "erasure triggered by
 * policy instead of by request," not a different outcome.
 */
export async function sweepInactivePersons(prisma: PrismaClient, cutoff: Date): Promise<SweepInactivePersonsResult> {
  const stale = await prisma.person.findMany({
    where: { status: "active", updatedAt: { lt: cutoff } },
    select: { id: true },
  });

  for (const person of stale) {
    const anonymizedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.person.update({
        where: { id: person.id },
        data: {
          email: anonymizedEmailFor(person.id),
          displayName: ANONYMIZED_DISPLAY_NAME,
          bio: null,
          avatarUrl: null,
          dateOfBirth: null,
          status: "anonymized",
          anonymizedAt,
        },
      });

      await tx.roleAssignment.updateMany({
        where: { subjectId: person.id, revokedAt: null },
        data: { revokedBy: null, revokedAt: anonymizedAt },
      });

      await tx.identityDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "Person",
          aggregateId: person.id,
          eventType: "PersonAnonymized",
          payload: {
            personId: person.id,
            anonymizedAt: anonymizedAt.toISOString(),
            reason: "retention_sweep",
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: null,
        actorType: "system",
        action: "person.anonymize",
        resourceType: "person",
        resourceId: person.id,
        metadata: { reason: "retention_sweep", dataClass: "inactive_volunteer_pii" },
      });
    });
  }

  return { anonymizedCount: stale.length };
}
