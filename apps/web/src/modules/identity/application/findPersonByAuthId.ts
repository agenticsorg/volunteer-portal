import type { PrismaClient } from "@prisma/client";

/**
 * The domain-shaped projection of a `Person` this module hands to tRPC
 * context and to callers of `identity.me` — never the raw Prisma row,
 * and certainly never anything Supabase-shaped (see
 * `server/auth/verified-session.ts`'s file-level ACL note).
 *
 * `primaryChapterId` is included because this is the caller's OWN,
 * already-authenticated profile (`ctx.person`), not the cross-context
 * `getPersonSummary` Open Host Service read another module uses to look
 * up an arbitrary `personId` — that read deliberately excludes chapter
 * membership (see `getPersonSummary.ts`'s own doc comment). A module that
 * needs "the chapter *the current caller* belongs to" (e.g.
 * `community.createPost`'s `authorChapterId`, whose own doc comment
 * calls for it to be "resolved ... from the authenticated session/
 * profile") reads it off `ctx.person` here, never via a cross-context
 * query for someone else's chapter.
 */
export interface PersonSummary {
  personId: string;
  publicSlug: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  primaryChapterId: string | null;
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
    select: {
      id: true,
      publicSlug: true,
      displayName: true,
      avatarUrl: true,
      status: true,
      primaryChapterId: true,
    },
  });

  if (!person) return null;

  return {
    personId: person.id,
    publicSlug: person.publicSlug,
    displayName: person.displayName,
    avatarUrl: person.avatarUrl,
    status: person.status,
    primaryChapterId: person.primaryChapterId,
  };
}
