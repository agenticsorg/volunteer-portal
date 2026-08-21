/**
 * GET /api/v1/admin/exports/:exportJobId
 *
 * docs/ddd/admin-reporting.md's API Contract Sketch: "Returns { status,
 * rowCount, outputFileFormat, outputFileExpiresAt } as JSON — a lightweight
 * polling endpoint for the admin console while a long-running export is
 * 'running', so the UI doesn't need a websocket for what is normally a
 * sub-minute wait." Session-authenticated (`resolveRequestPerson`) — the
 * `exportJob.get` tRPC procedure this wraps requires `export.request`
 * authority (`org_admin`), same gate `server/api/routers/admin.ts`'s own
 * `exportJob.get` procedure gives that use case.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { PolicySubject } from "@volunteer-portal/authz";
import { prisma } from "@/server/db/prisma";
import { resolveRequestPerson } from "@/server/auth/session-person";
import { getExportJob, ExportJobNotFoundError, ForbiddenActionError } from "@/modules/admin";

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
    const job = await getExportJob(prisma, { caller, id: exportJobId });
    return NextResponse.json({
      status: job.status,
      rowCount: job.rowCount,
      outputFileFormat: job.outputFileFormat,
      outputFileExpiresAt: job.outputFileExpiresAt,
    });
  } catch (error) {
    if (error instanceof ExportJobNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ForbiddenActionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
