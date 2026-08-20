import { defineConfig } from "vitest/config";

// ADR-0015 splits Vitest into a "unit" project (pure functions/modules, no
// database, no network) and an "integration" project (real Postgres via
// testcontainers, once domain logic exists to exercise). Phase 0 has no
// domain logic yet, so both projects currently hold nothing but a trivial
// smoke test proving the harness itself runs — real coverage lands with the
// features that need it.
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
        },
      },
    ],
  },
});
