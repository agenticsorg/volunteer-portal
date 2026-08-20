/**
 * GET /api/v1/hour-entries/export/:exportId
 *
 * The download endpoint `hourEntries.exportApproved`'s `csvUrl` points at
 * — same shape as `/api/v1/persons/:personId/dsar-export`: a signed,
 * expiring `?token=` query param (`server/volunteering/signing.ts`)
 * authenticates the request instead of a Supabase session, since this URL
 * is designed to be handed to the browser (or a download client) directly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readExportFile } from "@/server/volunteering/exportStorage";
import { verifyExportDownloadToken } from "@/server/volunteering/signing";

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ exportId: string }> },
) {
  const { exportId } = await params;
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing token." }, { status: 400 });
  }

  const verified = verifyExportDownloadToken(token);
  // Same generic failure for "forged", "expired", and "wrong export" — see
  // verifyExportDownloadToken's doc comment on not distinguishing failure modes.
  if (!verified || verified.exportId !== exportId) {
    return NextResponse.json({ error: "Invalid or expired export link." }, { status: 403 });
  }

  const file = await readExportFile(verified.exportId, verified.format);
  if (!file) {
    return NextResponse.json({ error: "Export artifact missing." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(file), {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPES[verified.format],
      "content-disposition": `attachment; filename="approved-hours-${verified.exportId}.${verified.format}"`,
    },
  });
}
