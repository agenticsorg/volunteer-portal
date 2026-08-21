import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as healthzGET } from "@/app/healthz/route";
import { GET as readyzGET } from "@/app/readyz/route";

const ENV_KEYS = ["CLOUDFLARE_STREAM_HEALTH_URL", "SUPABASE_AUTH_HEALTH_URL"] as const;

// ADR-0013's /healthz + /readyz, exercised as real Route Handlers against
// the real testcontainer Postgres this integration project's globalSetup
// stands up (tests/integration/setup.ts) — no mocked Prisma client.
describe("/healthz and /readyz (integration)", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("GET /healthz always returns 200 ok, no DB involved", async () => {
    const response = healthzGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 ready when the real Postgres is reachable and downstream checks are unconfigured", async () => {
    const response = await readyzGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(body.checks.find((c: { name: string }) => c.name === "database")).toMatchObject({ status: "ok" });
    // Unconfigured in this environment (no real Cloudflare/Supabase health
    // URLs) — reported as skipped, not as a failure (see health.ts's doc
    // comment for the honesty-constraint rationale), and does NOT crash.
    expect(body.checks.find((c: { name: string }) => c.name === "cloudflare_stream")).toMatchObject({
      status: "skipped",
    });
    expect(body.checks.find((c: { name: string }) => c.name === "supabase_auth")).toMatchObject({
      status: "skipped",
    });
  });

  it("GET /readyz reports degraded (503), never throws, when the DB connection string is broken", async () => {
    // A second PrismaClient pointed at a nonexistent database — proves
    // computeReadyz's real DB check genuinely fails closed rather than
    // vacuously succeeding, without touching the shared test Postgres any
    // other test in this run depends on.
    const brokenPrisma = new PrismaClient({
      datasources: { db: { url: "postgresql://nobody:nobody@127.0.0.1:1/does_not_exist" } },
    });
    try {
      const { computeReadyz } = await import("@/server/observability/health");
      const result = await computeReadyz(brokenPrisma);
      expect(result.status).toBe("degraded");
      expect(result.checks.find((c) => c.name === "database")).toMatchObject({ status: "failed" });
    } finally {
      await brokenPrisma.$disconnect();
    }
  });
});
