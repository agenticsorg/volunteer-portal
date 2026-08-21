/**
 * GET /api/v1/admin/exports/:exportJobId/download
 *
 * docs/ddd/admin-reporting.md's API Contract Sketch: "Authenticated +
 * org_admin (or original requester) via can(); 410 if expired; otherwise a
 * 302 redirect to a freshly-minted, 15-minute-TTL presigned R2 GET URL.
 * Never returns the R2 URL as JSON to avoid it being cached/logged
 * somewhere with a longer effective lifetime." Thin wrapper over
 * `GetExportDownloadUrl` (Key Use Case 7) — every precondition (ownership,
 * `status = 'completed'`, expiry) is that use case's own job; this route
 * only resolves the caller's session and translates its errors to HTTP
 * status codes, same split every other Route Handler in this app follows.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { PolicySubject } from "@volunteer-portal/authz";
import { prisma } from "@/server/db/prisma";
import { resolveRequestPerson } from "@/server/auth/session-person";
import {
  getExportDownloadUrl,
  ExportJobDownloadExpiredError,
  ExportJobNotDownloadableError,
  ExportJobNotFoundError,
  ExternalServiceNotConfiguredError,
  ForbiddenActionError,
} from "@/modules/admin";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ exportJobId: string }> },
) {
  const { exportJobId } = await params;

  const person = await resolveRequestPerson(request);
  if (!person) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const caller: PolicySubject = { id: person.personId, status: person.status as PolicySubject["status"] };

  try {
    const { url } = await getExportDownloadUrl(prisma, { caller, exportJobId });
    // 302, never JSON — see this file's header note on why the presigned
    // URL itself is never handed back as a response body.
    return NextResponse.redirect(url, { status: 302 });
  } catch (error) {
    if (error instanceof ExportJobNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ForbiddenActionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ExportJobNotDownloadableError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ExportJobDownloadExpiredError) {
      // The API Contract Sketch's own "410 if expired".
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    if (error instanceof ExternalServiceNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}
