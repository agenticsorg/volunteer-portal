/**
 * GET /readyz — real DB connectivity + best-effort downstream reachability
 * (ADR-0013's Implementation Notes sketch). See `../../server/observability/health.ts`
 * for `computeReadyz`'s actual check logic and its documented, deliberate
 * divergence from the ADR sketch (unconfigured downstream checks are
 * reported as `"skipped"`, not folded into a failure).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { computeReadyz } from "@/server/observability/health";

export async function GET() {
  const result = await computeReadyz(prisma);
  return NextResponse.json(result, { status: result.status === "ready" ? 200 : 503 });
}
