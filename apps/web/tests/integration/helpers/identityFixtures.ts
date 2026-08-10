import type { IdentityRoleName, IdentityScopeType, PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";

/**
 * Shared fixtures for the Phase 2 identity-use-case integration suites
 * (roleAssignments/consent/chapters/dsar). Inserts rows directly via
 * Prisma rather than through the use cases under test — a test proving
 * `grantRole` requires `org_admin` cannot itself depend on `grantRole` to
 * create that first `org_admin`.
 */

export async function createPerson(
  prisma: PrismaClient,
  overrides: Partial<{ displayName: string; status: string; dateOfBirth: Date }> = {},
) {
  const id = newId();
  return prisma.person.create({
    data: {
      id,
      publicSlug: `${id.toLowerCase()}-slug`,
      supabaseAuthId: newId(),
      email: `${id.toLowerCase()}@example.com`,
      displayName: overrides.displayName ?? "Test Person",
      ageAttested16Plus: overrides.dateOfBirth ? false : true,
      dateOfBirth: overrides.dateOfBirth,
      status: overrides.status ?? "active",
    },
  });
}

export async function grantRoleDirect(
  prisma: PrismaClient,
  args: {
    subjectId: string;
    role: IdentityRoleName;
    scopeType?: IdentityScopeType;
    scopeId?: string | null;
    grantedBy: string;
  },
) {
  return prisma.roleAssignment.create({
    data: {
      id: newId(),
      subjectId: args.subjectId,
      role: args.role,
      scopeType: args.scopeType ?? "global",
      scopeId: args.scopeId ?? null,
      grantedBy: args.grantedBy,
    },
  });
}

/**
 * Builds a `Context` (`server/api/trpc.ts`) for a given `person` row
 * without going through a real Supabase JWT — the router-level
 * integration suites (`identityRouter.integration.test.ts`) exercise real
 * procedures via `createCallerFactory` against this hand-built context, the
 * same way a verified session would populate `ctx.person`/`ctx.supabaseSession`.
 */
export function contextFor(
  prisma: PrismaClient,
  person: { id: string; publicSlug: string; displayName: string; avatarUrl: string | null; status: string },
) {
  return {
    headers: new Headers(),
    prisma,
    supabaseSession: { supabaseAuthId: newId(), email: `${person.id.toLowerCase()}@example.com` },
    person: {
      personId: person.id,
      publicSlug: person.publicSlug,
      displayName: person.displayName,
      avatarUrl: person.avatarUrl,
      status: person.status,
    },
  };
}

export async function createChapterDirect(
  prisma: PrismaClient,
  overrides: Partial<{ name: string; city: string; country: string }> = {},
) {
  const id = newId();
  return prisma.chapter.create({
    data: {
      id,
      name: overrides.name ?? "Test Chapter",
      slug: `test-chapter-${id.toLowerCase()}`,
      city: overrides.city ?? "Testville",
      country: overrides.country ?? "Testland",
    },
  });
}
