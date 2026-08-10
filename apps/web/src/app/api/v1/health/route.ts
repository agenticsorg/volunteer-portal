/**
 * GET /api/v1/health — liveness check and pattern-proof for the versioned
 * public REST API (ADR-0003). Every future `/api/v1/*` resource route
 * follows this same shape: a Next.js Route Handler under
 * `src/app/api/v1/<resource>/route.ts` that is a thin adapter over a
 * module's application-layer use case.
 *
 * This route has no such use case to adapt (no domain logic in Phase 0) —
 * it only proves the versioned-REST mount point exists and responds.
 */
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
