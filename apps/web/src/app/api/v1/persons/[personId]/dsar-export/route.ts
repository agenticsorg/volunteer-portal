/**
 * GET /api/v1/persons/:personId/dsar-export
 *
 * identity-access-schema-api.md's REST sketch: "signed URL redirect once
 * `completed`" — the endpoint a `DSARRequest(type='export').exportFileUrl`
 * points at. Verifies the signed, expiring `?token=` query param
 * (`server/dsar/signing.ts`) rather than relying on the caller's own
 * session, since this URL is designed to be handed to the browser (or a
 * download client) directly, the same shape a presigned cloud-storage URL
 * would take once this phase's local-filesystem stand-in is swapped for
 * one (see `server/dsar/exportStorage.ts`'s file header).
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/db/prisma";
import { DsarRequestNotFoundError, getDsarStatus } from "@/modules/identity";
import { readExportBundle } from "@/server/dsar/exportStorage";
import { verifyExportToken } from "@/server/dsar/signing";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ personId: string }> },
) {
  const { personId } = await params;
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing token." }, { status: 400 });
  }

  const verified = verifyExportToken(token);
  // Same generic failure for "forged", "expired", and "wrong person" —
  // see verifyExportToken's doc comment on not distinguishing failure modes.
  if (!verified || verified.personId !== personId) {
    return NextResponse.json({ error: "Invalid or expired export link." }, { status: 403 });
  }

  // Routed through the identity module's own sanctioned read (ADR-0001 —
  // no code outside modules/identity may query its Prisma models
  // directly, including this route, which lives under app/api/v1 rather
  // than modules/identity itself).
  let dsarRequest;
  try {
    dsarRequest = await getDsarStatus(prisma, verified.dsarId);
  } catch (error) {
    if (error instanceof DsarRequestNotFoundError) {
      return NextResponse.json({ error: "Export not found or not ready." }, { status: 404 });
    }
    throw error;
  }
  if (
    dsarRequest.personId !== personId ||
    dsarRequest.type !== "export" ||
    dsarRequest.status !== "completed"
  ) {
    return NextResponse.json({ error: "Export not found or not ready." }, { status: 404 });
  }

  const bundle = await readExportBundle(verified.dsarId);
  if (!bundle) {
    return NextResponse.json({ error: "Export artifact missing." }, { status: 404 });
  }

  return new NextResponse(bundle, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="dsar-export-${verified.dsarId}.json"`,
    },
  });
}
