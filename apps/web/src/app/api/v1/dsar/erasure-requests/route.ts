/**
 * POST /api/v1/dsar/erasure-requests
 *
 * identity-access-schema-api.md's REST sketch: "org-admin only, API-key
 * authenticated" — the endpoint external/admin tooling that cannot use
 * tRPC uses to file an erasure DSAR on a person's behalf. Authenticated
 * via `x-api-key` (`server/auth/apiKey.ts`), not a Supabase session — see
 * that file's header for why a client-supplied `requestedBy` is safe here
 * even though the equivalent tRPC procedure (`identity.dsar.requestErasure`)
 * deliberately does *not* accept one (see that router's file header).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidUlid } from "@volunteer-portal/ulid";
import { prisma } from "@/server/db/prisma";
import { verifyAdminApiKey } from "@/server/auth/apiKey";
import {
  requestErasure,
  ForbiddenActionError,
  OpenDsarRequestExistsError,
  PersonAlreadyAnonymizedError,
  PersonNotFoundError,
} from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

const bodySchema = z.object({
  personId: ulidSchema,
  requestedBy: ulidSchema,
});

export async function POST(request: NextRequest) {
  if (!verifyAdminApiKey(request)) {
    return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await requestErasure(prisma, parsed.data);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof PersonNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // ForbiddenActionError here means `requestedBy` is neither the subject
    // nor an active org_admin — the API key alone doesn't grant that (see
    // this file's header note).
    if (error instanceof ForbiddenActionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof OpenDsarRequestExistsError ||
      error instanceof PersonAlreadyAnonymizedError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
