import type { PrismaClient } from "@prisma/client";

/**
 * The domain-shaped projection of a `Person` this module hands to tRPC
 * context and to callers of `identity.me` — never the raw Prisma row,
 * and certainly never anything Supabase-shaped (see
 * `server/auth/verified-session.ts`'s file-level ACL note).
 */
export interface PersonSummary {
  personId: string;
  publicSlug: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
}

/**
 * Resolves the `Person` row for an already-verified `supabaseAuthId`
 * (ADR-0006: "the resolved `person` (looked up by `auth_user_id` from the
 * validated Supabase session) is attached to tRPC context"). Returns
 * `null` both when the auth id is unknown and when no session was
 * verified at all — callers pass `null` straight through in the latter
 * case rather than querying.
 */
export async function findPersonByAuthId(
  prisma: PrismaClient,
  supabaseAuthId: string,
): Promise<PersonSummary | null> {
  const person = await prisma.person.findUnique({
    where: { supabaseAuthId },
    select: { id: true, publicSlug: true, displayName: true, avatarUrl: true, status: true },
  });

  if (!person) return null;

  return {
    personId: person.id,
    publicSlug: person.publicSlug,
    displayName: person.displayName,
    avatarUrl: person.avatarUrl,
    status: person.status,
  };
}
