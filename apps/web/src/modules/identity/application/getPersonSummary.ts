import type { PrismaClient } from "@prisma/client";

/**
 * The public, cross-context-safe projection of a `Person`
 * (identity-access-schema-api.md's `getPersonSummary` contract: `->
 * { personId, publicSlug, displayName, avatarUrl } | null`). Deliberately
 * excludes every field this context treats as sensitive (`email`,
 * `dateOfBirth`, `bio`, `status`, ...) — this is the *only* shape any
 * other bounded-context module (or the frontend, for another user's
 * public profile) is ever handed when reading Person data.
 */
export interface PersonPublicSummary {
  personId: string;
  publicSlug: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * GetPersonSummary — the Open Host Service read
 * (identity-access-schema-api.md's API Contract Sketch;
 * Integration & Anti-Corruption Notes: "every cross-context read goes
 * through `getPersonSummary` ... via this module's `index.ts`").
 *
 * No `can()` gate: every field returned is already meant to be publicly
 * visible (a display name and avatar), so this is a plain read, not a
 * privileged action. For an anonymized `Person`
 * (`RequestErasure`/`AnonymizePerson` already overwrote `displayName`/
 * `avatarUrl` in place), this naturally and correctly returns the
 * anonymized placeholder — no special-casing needed here, per the doc's
 * "`PersonAnonymized` is a fan-out, not a cascade" note.
 */
export async function getPersonSummary(
  prisma: PrismaClient,
  personId: string,
): Promise<PersonPublicSummary | null> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { id: true, publicSlug: true, displayName: true, avatarUrl: true },
  });

  if (!person) return null;

  return {
    personId: person.id,
    publicSlug: person.publicSlug,
    displayName: person.displayName,
    avatarUrl: person.avatarUrl,
  };
}
