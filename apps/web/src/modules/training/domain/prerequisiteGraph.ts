/**
 * Pure graph logic for `training.module_prerequisite` (docs/ddd/
 * training-learning.md's `ModulePrerequisite` value object: "a directed
 * dependency DAG within a course"). No Prisma/database dependency — takes
 * plain edges, so it's unit-testable in isolation and reusable by any use
 * case that adds prerequisite edges.
 */

/** `edges.get(moduleId)` = the set of moduleIds `moduleId` directly depends on. */
export type PrerequisiteEdges = ReadonlyMap<string, readonly string[]>;

/**
 * True iff adding a `from -> to` edge ("`from` depends on `to`") to
 * `edges` would create a cycle — i.e. `to` can already (transitively)
 * reach `from` via existing edges, so the new edge would close a loop.
 * AddModule (Key Use Case 2) rejects any prerequisite declaration for
 * which this returns `true`.
 */
export function wouldCreateCycle(edges: PrerequisiteEdges, from: string, to: string): boolean {
  if (from === to) return true;

  const visited = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of edges.get(current) ?? []) {
      stack.push(next);
    }
  }
  return false;
}
