/**
 * GET /healthz — liveness only (ADR-0013's Implementation Notes sketch).
 * No downstream checks (no DB, no external services) — this must always be
 * fast and always succeed as long as the Node process itself is up, so an
 * external uptime prober can distinguish "the process is alive" from "the
 * process is alive but degraded" (that distinction is `/readyz`'s job —
 * see `../readyz/route.ts`).
 */
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
