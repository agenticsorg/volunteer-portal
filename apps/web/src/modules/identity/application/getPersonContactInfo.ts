import type { PrismaClient } from "@prisma/client";

/**
 * The one Person projection that DOES include `email` — deliberately
 * separate from `getPersonSummary`'s `PersonPublicSummary` (which excludes
 * it as sensitive, per that function's own doc comment), and deliberately
 * narrow: this exists for exactly one purpose, sending a transactional
 * email to the Person it belongs to (`notifications.ProcessDeliveryJob`,
 * ADR-0012's Resend integration), never for display anywhere. No other
 * bounded-context module has a legitimate reason to read a Person's email
 * address — `notifications` is the only consumer this is exported for.
 */
export interface PersonContactInfo {
  personId: string;
  email: string;
  displayName: string;
}

/**
 * GetPersonContactInfo — a narrow Open Host Service read, additive to
 * identity-access-schema-api.md's own `getPersonSummary` contract (that doc
 * predates `notifications`' own Resend integration need). Returns `null`
 * for a Person that doesn't exist OR whose `status` is not `active`
 * (`deactivated`/`anonymized`) — an anonymized Person's `email` column
 * holds a synthetic `deleted+<ulid>@agentics.invalid` placeholder
 * (ADR-0014 §2) that must never be handed to an outbound email provider,
 * and a deactivated account should not receive new transactional email
 * either. `ProcessDeliveryJob` treats a `null` result the same as "Resend
 * has nothing to deliver to" — a delivery failure, not a crash.
 */
export async function getPersonContactInfo(
  prisma: PrismaClient,
  personId: string,
): Promise<PersonContactInfo | null> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { id: true, email: true, displayName: true, status: true },
  });

  if (!person || person.status !== "active") return null;

  return { personId: person.id, email: person.email, displayName: person.displayName };
}
