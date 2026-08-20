/**
 * GET /api/v1/hour-entries/export?from=&to=&chapterId=&format=csv|pdf
 *
 * docs/ddd/volunteering-opportunities-schema-api.md: "Also exposed under
 * versioned public REST for grant/board tooling that lives outside the
 * app ... same authorization rule as `exportApproved`, API-key
 * authenticated." Unlike the tRPC `hourEntries.exportApproved` query,
 * there is no Supabase session here to resolve a caller's own
 * `role_assignments` from — this route has no per-caller identity at all,
 * the same "external tooling with no browser session" shape
 * `server/auth/apiKey.ts` documents for the identity DSAR REST surface.
 * `hours.export`'s policy resolves to "org_admin, or chapter_lead scoped
 * to the requested chapter" (packages/authz) when a real caller is known;
 * here, a valid `x-api-key` stands in for that authority outright — the
 * key itself is provisioned specifically for this org-wide grant/board
 * reporting surface, the same "the key IS the authorization" shape
 * `POST /api/v1/dsar/erasure-requests` documents does NOT use (that route
 * still re-derives authorization from a caller-supplied `requestedBy`)
 * because unlike an erasure request acting on a specific person's behalf,
 * a grant/board export has no natural "acting as" identity to re-derive
 * scoped authority from. A deployment that wants per-caller, chapter-scoped
 * API keys can extend `verifyAdminApiKey` later without changing this
 * route's shape.
 *
 * Generates the CSV/PDF directly in the response body — no signed-URL
 * indirection needed, since the API key itself already authenticates the
 * request synchronously.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidUlid } from "@volunteer-portal/ulid";
import { prisma } from "@/server/db/prisma";
import { queryApprovedHours } from "@/modules/volunteering";
import { verifyAdminApiKey } from "@/server/auth/apiKey";
import { summarizeApprovedHours } from "@/server/volunteering/valuation";
import { buildApprovedHoursCsv } from "@/server/volunteering/csv";
import { buildApprovedHoursPdf } from "@/server/volunteering/pdf";
import { dayStart, dayEnd } from "@/server/volunteering/dateRange";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

const querySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  chapterId: ulidSchema.optional(),
  format: z.enum(["csv", "pdf"]).default("csv"),
});

export async function GET(request: NextRequest) {
  if (!verifyAdminApiKey(request)) {
    return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    chapterId: searchParams.get("chapterId") ?? undefined,
    format: searchParams.get("format") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters.", issues: parsed.error.issues }, { status: 400 });
  }
  const { from, to, chapterId, format } = parsed.data;

  const records = await queryApprovedHours(prisma, {
    chapterId,
    fromDate: dayStart(from),
    toDate: dayEnd(to),
  });
  const summary = summarizeApprovedHours(records);

  if (format === "pdf") {
    const pdf = buildApprovedHoursPdf(records, summary, { fromDate: from, toDate: to, chapterId });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="approved-hours-${from}-to-${to}.pdf"`,
      },
    });
  }

  const csv = buildApprovedHoursCsv(records);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="approved-hours-${from}-to-${to}.csv"`,
    },
  });
}
