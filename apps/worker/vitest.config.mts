import { defineConfig } from "vitest/config";

// Unit tests only (no `postgres`/graphile-worker runtime involved) — this
// app's behavior against real Postgres is exercised by apps/web's own
// integration suite, which spawns the real `apps/worker` process
// (`tests/integration/auditLogWriter.integration.test.ts`) rather than
// re-implementing that coverage here. This config exists for the smaller,
// genuinely pure-function/fake-dependency slice: observability wiring
// (`src/observability/withJobErrorCapture.ts`'s own `extractRequestId` and
// catch/report/rethrow logic).
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
