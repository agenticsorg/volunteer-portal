import { defineConfig } from "vitest/config";

// ADR-0015 splits Vitest into a "unit" project (pure functions/modules, no
// database, no network) and an "integration" project (real Postgres via
// testcontainers). The "integration" project's `globalSetup`
// (tests/integration/setup.ts) starts one disposable `postgres:16`
// container per `pnpm test:integration` run, applies every Prisma
// migration, and installs graphile-worker's bookkeeping schema — no test
// here ever depends on a pre-existing DATABASE_URL / the developer's
// docker-compose Postgres.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["**/*.test.ts", "**/*.test.tsx"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/.next/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["**/*.integration.test.ts"],
          exclude: ["**/node_modules/**", "**/.next/**"],
          globalSetup: ["./tests/integration/setup.ts"],
          // Container startup + `prisma migrate deploy` + graphile-worker
          // schema install (globalSetup) and, for auditLogWriter's test,
          // spawning/waiting on a real graphile-worker process, are all
          // slower than the Vitest defaults assume.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
