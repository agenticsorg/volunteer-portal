# ADR 0016: Ruflo Plugin/Tooling Installation Mechanism Documentation

## Status

Accepted — 2026-08-19

## Context

`concept.md` section 10 lists several `ruflo-*` build-harness plugins
(`ruflo-sparc`, `ruflo-ddd`, `ruflo-migrations`, `ruflo-testgen`,
`ruflo-browser`, `ruflo-aidefence`, `ruflo-adr`) as part of the
development-time toolchain, without specifying how they're installed.
`research-findings.md` confirms these are real packages that do
roughly what concept.md claims, but identifies a distribution-mechanism
error: they are not standalone npm packages (`npm install ruflo-sparc`
404s), but are distributed via the Claude Code plugin marketplace and
invoked as, e.g., `ruflo-sparc@ruflo` after installation via
`/plugin marketplace add ruvnet/ruflo` or the equivalent CLI command.
build-roadmap.md lists this as a Phase 0 decision item, explicitly
flagged as "non-blocking for architecture, but should be corrected in
build docs before other agents rely on the concept.md text literally."

This ADR is unlike the others in this series: it does not decide an
architecture question, it corrects a documentation error so future
contributors and agents don't waste time on a literal `npm install` that
will fail. It is included as its own ADR, rather than folded into
[[0001-language-and-stack-strategy]], because build-roadmap.md lists it
as a discrete Phase 0 checklist item and it deserves its own citable
record.

## Decision

**Documentation correction, recorded here as the source of truth:**
`ruflo-*` packages referenced anywhere in this project's planning
documents (`concept.md`, this ADR series, build-roadmap.md) are Claude
Code plugin-marketplace entries, not npm packages. The correct
installation path is via the Claude Code plugin marketplace (e.g.
`/plugin marketplace add ruvnet/ruflo`, then enabling the specific
plugin), after which the plugin's skills/tools become available inside a
Claude Code session — they are never added to this project's
`package.json` or `Cargo.toml`, and are not a runtime dependency of the
shipped application (consistent with [[0001-language-and-stack-
strategy]]'s framing that build tooling is not counted against the
Rust-first mandate, since none of it ships in the production binary or
frontend bundle).

Separately, as noted in the teammate handoff for this ADR series: the
`ruflo`/`claude-flow` MCP tools referenced in this repository's
`CLAUDE.md` (`memory_store`, ADR-indexing tools, `guidance_brain`, etc.)
were confirmed **not actually registered** in this working environment as
of this writing. Contributors and agents should not assume these tools
are available; work directly with files in the repository (as this ADR
series itself does) unless and until those tools are confirmed present
in a given session via `ToolSearch` or an equivalent discovery step.

## Consequences

**Positive:**
- Prevents future contributors or agents from attempting a literal
  `npm install ruflo-sparc` (or similar) based on a naive reading of
  concept.md section 10, wasting time on a guaranteed 404.
- Documents, in one place, that MCP-tool availability should be verified
  per-session rather than assumed from `CLAUDE.md`'s presence — a
  practical note that would otherwise only live in this session's
  transient context.

**Negative / accepted risk:**
- This ADR does not itself update `concept.md`'s section 10 text — it
  records the correction as an accepted decision, but concept.md remains
  the original, imprecise source unless a follow-up documentation change
  is made there directly. Flagged so it isn't assumed this ADR alone
  fixes the primary spec document.

## Alternatives Considered

- **Fold this correction into ADR 0001 as a footnote.** Considered;
  rejected in favor of a standalone ADR because build-roadmap.md lists it
  as its own discrete Phase 0 checklist item, and a standalone,
  independently-citable record is more useful for a documentation
  correction that future contributors may need to find directly (e.g.
  via search for "ruflo install") without reading the entire stack-
  strategy ADR.
- **Edit `concept.md` directly instead of recording an ADR.** Considered;
  not done as part of this ADR series, which is scoped to writing
  decision records, not editing the original spec document. Recommended
  as a natural follow-up task, not performed here to avoid scope creep
  beyond what was requested.

## Phase Gate

Non-blocking for architecture (per build-roadmap.md's own framing), but
should be read by any contributor or agent before relying on
`concept.md` section 10's tooling list literally, at any phase.
