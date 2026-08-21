import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeReadyz, type DbHealthClient } from "@/server/observability/health";

const ENV_KEYS = ["CLOUDFLARE_STREAM_HEALTH_URL", "SUPABASE_AUTH_HEALTH_URL"] as const;

function okDb(): DbHealthClient {
  return { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) };
}

function failingDb(): DbHealthClient {
  return { $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")) };
}

// ADR-0013's /readyz sketch, unit-tested against fakes (the real-Postgres
// case is covered by tests/integration/health.integration.test.ts).
describe("computeReadyz", () => {
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
    vi.restoreAllMocks();
  });

  it("is 'ready' when the DB check passes and downstream checks are unconfigured (skipped, not failed)", async () => {
    const result = await computeReadyz(okDb());
    expect(result.status).toBe("ready");
    expect(result.checks).toContainEqual({ name: "database", status: "ok" });
    expect(result.checks.find((c) => c.name === "cloudflare_stream")).toMatchObject({ status: "skipped" });
    expect(result.checks.find((c) => c.name === "supabase_auth")).toMatchObject({ status: "skipped" });
  });

  it("never throws when a downstream health-check env var is unset — degrades gracefully, not a crash", async () => {
    await expect(computeReadyz(okDb())).resolves.not.toThrow();
  });

  it("is 'degraded' (not a thrown error) when the DB check fails", async () => {
    const result = await computeReadyz(failingDb());
    expect(result.status).toBe("degraded");
    expect(result.checks.find((c) => c.name === "database")).toMatchObject({ status: "failed" });
  });

  it("checks a configured downstream URL for real and reports failure without throwing when it 404s", async () => {
    process.env.CLOUDFLARE_STREAM_HEALTH_URL = "https://stream.example.test/health";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));

    const result = await computeReadyz(okDb());

    expect(result.status).toBe("degraded");
    expect(result.checks.find((c) => c.name === "cloudflare_stream")).toMatchObject({ status: "failed" });
  });

  it("reports a configured downstream URL as ok when it responds successfully", async () => {
    process.env.SUPABASE_AUTH_HEALTH_URL = "https://auth.example.test/health";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const result = await computeReadyz(okDb());

    expect(result.checks.find((c) => c.name === "supabase_auth")).toMatchObject({ status: "ok" });
    expect(result.status).toBe("ready");
  });

  it("degrades gracefully (not a 500) when a configured downstream URL's fetch itself throws (network error)", async () => {
    process.env.CLOUDFLARE_STREAM_HEALTH_URL = "https://stream.example.test/health";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await computeReadyz(okDb());

    expect(result.status).toBe("degraded");
    expect(result.checks.find((c) => c.name === "cloudflare_stream")).toMatchObject({ status: "failed" });
  });
});
