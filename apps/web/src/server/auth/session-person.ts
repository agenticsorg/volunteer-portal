/**
 * Resolves the authenticated `identity.persons` row for a `NextRequest`
 * arriving at a Route Handler — the same two-step "verify the Supabase
 * session, then look up the `Person` it maps to" the tRPC context
 * (`server/api/trpc.ts`'s `createTRPCContext`) already performs, factored
 * out here so a Route Handler that needs real session auth (rather than a
 * signed, single-purpose `?token=`, per `server/dsar/signing.ts`'s/
 * `server/volunteering/signing.ts`'s own file headers on why THEIR
 * download routes use a token instead) doesn't hand-roll it.
 *
 * `modules/admin`'s two REST export routes (`GET /api/v1/admin/exports/
 * :exportJobId` and `.../download`) are this helper's first caller: per
 * docs/ddd/admin-reporting.md's API Contract Sketch, both are
 * "Authenticated + org_admin (or original requester) via `can()`" — a live
 * admin-console session, not a link handed to an anonymous browser tab the
 * way a DSAR export or approved-hours CSV download is — so real Supabase
 * session verification (not a token) is the correct auth for these two.
 *
 * Read-only with respect to cookies, same rationale as the tRPC context's
 * own `setAll: () => {}`: session *refresh* is `proxy.ts`'s job (it runs
 * on every request, including these, per its own `matcher`), so a Route
 * Handler never needs to write a renewed cookie back itself.
 */
import type { NextRequest } from "next/server";
import { createSupabaseServerClient } from "./supabase-server-client";
import { getVerifiedSession } from "./verified-session";
import { prisma } from "@/server/db/prisma";
import { findPersonByAuthId, type PersonSummary } from "@/modules/identity";

export async function resolveRequestPerson(request: NextRequest): Promise<PersonSummary | null> {
  const supabase = createSupabaseServerClient({
    getAll: () => request.cookies.getAll(),
    setAll: () => {},
  });

  const session = await getVerifiedSession(supabase);
  if (!session) {
    return null;
  }

  return findPersonByAuthId(prisma, session.supabaseAuthId);
}
