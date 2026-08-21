import { describe, expect, it } from "vitest";
import { isLegalReportStatusTransition } from "@/modules/moderation";

// Pure-function coverage for the Report status state machine
// (docs/ddd/moderation-trust-safety.md, Report invariant 3: `open ->
// reviewing -> resolved|dismissed`, plus the `reviewing -> open`
// claim-release edge and `open -> dismissed` fast-dismiss edge) — no
// database, per ADR-0015's unit/integration split.
// `claimReport.ts`/`releaseReportClaim.ts`/`resolveReport.ts`/
// `dismissReport.ts` each defer to this single predicate rather than
// re-deriving the legal-edge set inline.
describe("isLegalReportStatusTransition", () => {
  it("open -> reviewing (claim) is legal", () => {
    expect(isLegalReportStatusTransition("open", "reviewing")).toBe(true);
  });

  it("open -> dismissed (fast-dismiss) is legal", () => {
    expect(isLegalReportStatusTransition("open", "dismissed")).toBe(true);
  });

  it("reviewing -> resolved is legal", () => {
    expect(isLegalReportStatusTransition("reviewing", "resolved")).toBe(true);
  });

  it("reviewing -> dismissed is legal", () => {
    expect(isLegalReportStatusTransition("reviewing", "dismissed")).toBe(true);
  });

  it("reviewing -> open (release claim) is legal", () => {
    expect(isLegalReportStatusTransition("reviewing", "open")).toBe(true);
  });

  it("open -> resolved is illegal — a report must be claimed (reviewing) before it can resolve", () => {
    expect(isLegalReportStatusTransition("open", "resolved")).toBe(false);
  });

  it("resolved and dismissed are terminal — no transition out of either", () => {
    for (const to of ["open", "reviewing", "resolved", "dismissed"] as const) {
      expect(isLegalReportStatusTransition("resolved", to)).toBe(false);
      expect(isLegalReportStatusTransition("dismissed", to)).toBe(false);
    }
  });

  it("a status never legally transitions to itself, except reviewing has no self-loop either", () => {
    expect(isLegalReportStatusTransition("open", "open")).toBe(false);
    expect(isLegalReportStatusTransition("reviewing", "reviewing")).toBe(false);
  });
});
