import { describe, expect, it } from "vitest";
import { isValidUlid, newId } from "@volunteer-portal/ulid";

// Phase 0 smoke test: no domain logic exists yet to unit-test, so this only
// proves the Vitest "unit" project harness runs, resolves the pnpm
// workspace, and can import shared packages — by exercising the one piece
// of real (non-stub) shared code that exists so far.
describe("vitest unit harness", () => {
  it("runs and can exercise a real shared package", () => {
    const id = newId();
    expect(isValidUlid(id)).toBe(true);
  });
});
