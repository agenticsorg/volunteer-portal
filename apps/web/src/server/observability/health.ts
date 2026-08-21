/**
 * `/readyz`'s check logic (ADR-0013's Implementation Notes sketch), pulled
 * out of the route handler so it's directly integration-testable against a
 * real Postgres without going through an HTTP request.
 *
 * Deliberately diverges from the ADR sketch in one way: the sketch always
 * calls `fetch(env.CF_STREAM_HEALTH_URL, ...)`/`fetch(env.SUPABASE_AUTH_HEALTH_URL, ...)`
 * unconditionally, which would throw on `fetch(undefined, ...)` the moment
 * those env vars are unset — exactly this environment's situation (no real
 * Cloudflare/Supabase health-check URLs configured). A downstream check
 * that was never configured is not the same fact as a downstream check
 * that *failed*, so it's reported as its own `"skipped"` status rather than
 * folded into `"failed"` — `/readyz` still reports `"ready"` (200) when the
 * database is reachable and every configured check passes, exactly the
 * "does NOT crash when unset ... reports degraded gracefully, not a 500"
 * bar this stage's task asks for, without mischaracterizing "we didn't
 * check" as "it's broken".
 */
import { logger } from "./logger";

export type CheckStatus = "ok" | "failed" | "skipped";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface ReadyzResult {
  status: "ready" | "degraded";
  checks: CheckResult[];
}

/** The minimal shape this module needs from a Postgres client — real `PrismaClient` or a test double. */
export interface DbHealthClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

async function checkDb(db: DbHealthClient): Promise<CheckResult> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { name: "database", status: "ok" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("observability.readyz_check_failed", { context: { check: "database", detail } });
    return { name: "database", status: "failed", detail };
  }
}

/** A `HEAD`-request reachability probe against an optional env-configured URL — `"skipped"` when the env var isn't set. */
async function checkOptionalHttpEndpoint(name: string, envVarName: string): Promise<CheckResult> {
  const url = process.env[envVarName];
  if (!url) {
    return { name, status: "skipped", detail: `${envVarName} is not set` };
  }
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
      return { name, status: "failed", detail: `HTTP ${response.status}` };
    }
    return { name, status: "ok" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("observability.readyz_check_failed", { context: { check: name, detail } });
    return { name, status: "failed", detail };
  }
}

/**
 * Runs every check concurrently and never throws — every individual check
 * already catches its own error above, and `Promise.all` over
 * always-resolving promises can't reject either. `status` is `"degraded"`
 * only when a check that actually ran (`"ok"`/`"failed"`) came back
 * `"failed"`; `"skipped"` checks never move the needle.
 */
export async function computeReadyz(db: DbHealthClient): Promise<ReadyzResult> {
  const checks = await Promise.all([
    checkDb(db),
    checkOptionalHttpEndpoint("cloudflare_stream", "CLOUDFLARE_STREAM_HEALTH_URL"),
    checkOptionalHttpEndpoint("supabase_auth", "SUPABASE_AUTH_HEALTH_URL"),
  ]);
  const hasFailure = checks.some((c) => c.status === "failed");
  return { status: hasFailure ? "degraded" : "ready", checks };
}
