import { describe, expect, it } from "vitest";

// Phase 0 smoke test: no domain logic exists yet to exercise against a real
// Postgres instance, so this only proves the Vitest "integration" project
// is wired up and runs independently from "unit" (separate `vitest.config.ts`
// project, separate `pnpm test:integration` script). Per ADR-0015's
// Implementation Notes, real integration tests here will spin up Postgres
// via testcontainers and run `prisma migrate deploy` + graphile-worker's
// schema install — that lands once a bounded context has real behavior to
// verify cross-schema.
describe("vitest integration harness", () => {
  it("runs independently of the unit project", () => {
    expect(1 + 1).toBe(2);
  });
});
