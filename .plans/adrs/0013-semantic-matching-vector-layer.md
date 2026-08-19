# ADR 0013: Semantic Matching Vector Layer — TypeScript/`ruvector` Exception

## Status

Accepted — 2026-08-19

## Context

`concept.md` section 10 and Build Sequence step 9 (mirrored in
build-roadmap.md's Phase 9) specify a differentiator layer: free-text
skill matching against project descriptions, using `ruvector` (npm,
MIT-licensed), explicitly scoped as additive to — never a replacement
for — the deterministic SQL directory search. `concept.md` is explicit
that "everything else in the portal is deterministic SQL and must not be
routed through a vector store." Build-roadmap.md's Phase 0 flags this as
needing an explicit decision: is there a Rust-native vector/embedding
library viable here, or is `ruvector` (npm-only) used as a sanctioned
TypeScript exception for this one layer.

## Decision

**Use `ruvector` (TypeScript, npm-only) as a second, narrowly-scoped
sanctioned exception to [[0001-language-and-stack-strategy]]'s Rust-first
mandate**, alongside the frontend exception in
[[0011-frontend-architecture-typescript-exception]].

Rationale: `ruvector` is the tool `concept.md` names specifically for
this use case, is confirmed real and actively maintained
(research-findings.md verified it on the npm registry), and Rust-native
vector-search crates, while they exist for general-purpose use, do not
match `ruvector`'s specific fit for this application's stated need
(semantic search over short free-text skill descriptions with HNSW
indexing) closely enough to justify reimplementing or substituting at
this stage. Unlike the frontend decision, this is a bounded, optional,
clearly-isolated layer — not a foundational architectural commitment —
so the bar for taking a TypeScript exception here is lower and the
justification simpler: use the tool the product spec already named,
rather than re-litigate vector-library choice in Rust for a Phase 9
differentiator that must not be attempted before Phases 1-8 are stable
anyway.

**Isolation boundary:** the `ruvector` matching layer runs as its own
bounded service/module, called by the Rust backend over an internal API
(not embedded in-process in the Axum server), consuming volunteer
free-text skills and project descriptions and returning ranked
suggestions. It has **read-only** access to the data it needs (skills
text, project descriptions) — it does not hold its own copy of
authorization-sensitive state, and every suggestion it returns is
subject to the same RLS/authorization checks
([[0004-orm-and-row-level-security]]) as any other query before being
shown to a user, specifically to prevent the cross-project/cross-
volunteer data leakage risk build-roadmap.md's Phase 9 exit criteria
explicitly name as a concern (e.g. suggesting a volunteer to a project
whose applicant list they shouldn't see).

## Consequences

**Positive:**
- Uses the tool the product spec already validated for this exact
  purpose, avoiding a second, redundant research effort to find or build
  a Rust-native equivalent for a non-core differentiator feature.
- Clean isolation (its own service, read-only data access, authorization
  re-checked before results are shown) means a defect or outage in this
  layer cannot compromise the deterministic SQL core or bypass
  authorization elsewhere in the system — consistent with concept.md's
  own framing that this layer is additive, not load-bearing.
- Keeps the Rust-first mandate's exceptions to exactly two, both
  documented and justified ([[0011-frontend-architecture-typescript-
  exception]] and this ADR), rather than an unbounded set of ad hoc
  language choices creeping in component by component.

**Negative / accepted risk:**
- A third runtime component (alongside the Rust backend and TypeScript
  frontend) adds operational surface — another service to deploy,
  monitor, and patch. Justified by this being explicitly optional,
  Phase-9-only, and not required for the "first usable portal" milestone
  (Phases 1-4) or any compliance-critical path.
- `ruvector`'s match-quality behavior must be validated against a labeled
  test set before this layer ships, per build-roadmap.md's Phase 9 exit
  criteria — this ADR does not itself establish match quality, only the
  language/library choice.
- Because this is a second Node/TypeScript-adjacent dependency beyond the
  frontend, it modestly increases the total non-Rust surface area of the
  system beyond what a strict reading of "Rust as much as possible"
  would suggest — accepted here consistent with the same reasoning
  pattern as ADR 0011: use the right tool for a narrow, well-isolated
  purpose rather than force a worse Rust-native substitute for its own
  sake.

## Alternatives Considered

- **Rust-native vector/embedding crate** (e.g. a general-purpose HNSW or
  embedding-search crate). Considered per build-roadmap.md's explicit
  prompt to evaluate this. Rejected for v1 — no Rust-native option was
  identified in the research pass with `ruvector`'s specific combination
  of confirmed maturity and direct fit to this exact use case (free-text
  skill matching), and reimplementing this differentiator layer from
  scratch in Rust is not justified effort relative to its Phase 9,
  non-core status. Revisitable if a comparable Rust-native option
  matures before Phase 9 begins.
- **Skip semantic matching entirely for v1.** Rejected — not required by
  this ADR to decide; concept.md already scopes it as Phase 9/Build
  Sequence step 9, appropriately deferred but not cut. This ADR only
  resolves the language question for when that phase is reached.
- **Embed `ruvector` in-process within the Axum server via a Node
  subprocess or FFI bridge**, rather than as a separate service.
  Rejected — adds complexity and an unusual process-management pattern
  (Rust supervising a Node child process) for no clear benefit over a
  normal internal service boundary, and would blur the clean isolation
  this ADR relies on for its authorization/data-leakage safety argument.

## Phase Gate

Unblocks Phase 9 (Semantic matching) only. Explicitly must not be
attempted before Phases 1-8 are stable, per concept.md's own sequencing
note and build-roadmap.md's Phase 9 scope.
