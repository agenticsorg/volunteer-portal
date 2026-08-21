/**
 * GET /api/v1/courses
 *
 * docs/ddd/training-learning.md's API Contract Sketch: "the public
 * `/api/v1/*` REST surface (e.g. `GET /api/v1/courses`, ...) is a thin
 * read-oriented wrapper over the same application services." Public,
 * unauthenticated — the published course catalog, for external tooling
 * (a marketing site, a partner integration) that has no Supabase session
 * and no reason to speak tRPC. Wraps the exact same `getCourseCatalog`
 * read the `training.getCourseCatalog` tRPC query uses, always scoped to
 * `status: 'published'` — never any other status on this public surface.
 */
import { NextResponse } from "next/server";
import { getCourseCatalog } from "@/modules/training";
import { prisma } from "@/server/db/prisma";

export async function GET() {
  const courses = await getCourseCatalog(prisma, "published");
  return NextResponse.json({ courses });
}
