import { describe, expect, it } from "vitest";
import { wouldCreateCycle, type PrerequisiteEdges } from "@/modules/training";

// Pure graph logic for `training.module_prerequisite`'s DAG — no database,
// per ADR-0015's unit/integration split. `addModule.ts` (application
// layer) calls this on every declared prerequisite edge.
describe("wouldCreateCycle", () => {
  it("a module cannot depend on itself", () => {
    const edges: PrerequisiteEdges = new Map();
    expect(wouldCreateCycle(edges, "m1", "m1")).toBe(true);
  });

  it("a fresh edge with no existing relationship is not a cycle", () => {
    const edges: PrerequisiteEdges = new Map([["m1", ["m2"]]]);
    expect(wouldCreateCycle(edges, "m3", "m2")).toBe(false);
  });

  it("detects a direct 2-cycle (A depends on B, now B would depend on A)", () => {
    const edges: PrerequisiteEdges = new Map([["a", ["b"]]]);
    expect(wouldCreateCycle(edges, "b", "a")).toBe(true);
  });

  it("detects a transitive cycle (A -> B -> C, now C would depend on A)", () => {
    const edges: PrerequisiteEdges = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
    ]);
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
  });

  it("a diamond dependency (two independent paths to the same ancestor) is not a cycle", () => {
    // capstone depends on both electiveX and electiveY, which both depend
    // on foundation — a legitimate DAG, not a cycle.
    const edges: PrerequisiteEdges = new Map([
      ["electiveX", ["foundation"]],
      ["electiveY", ["foundation"]],
    ]);
    expect(wouldCreateCycle(edges, "capstone", "electiveX")).toBe(false);
    expect(wouldCreateCycle(edges, "capstone", "electiveY")).toBe(false);
  });

  it("an unrelated pair of modules with no path between them is not a cycle", () => {
    const edges: PrerequisiteEdges = new Map([["a", ["b"]]]);
    expect(wouldCreateCycle(edges, "x", "y")).toBe(false);
  });
});
