import { describe, expect, it } from "vitest";

// Phase 0 smoke test, retained in Phase 1: proves the Vitest "integration"
// project is wired up and runs independently from "unit" (separate
// project in vitest.config.mts, separate `pnpm test:integration` script).
// Real cross-schema/domain coverage against the testcontainers Postgres
// (see tests/integration/setup.ts) now lives in the other files in this
// directory (recordAuditEvent, drainOutbox, auditLogWriter,
// auditLogInsertOnly).
describe("vitest integration harness", () => {
  it("runs independently of the unit project", () => {
    expect(1 + 1).toBe(2);
  });
});
