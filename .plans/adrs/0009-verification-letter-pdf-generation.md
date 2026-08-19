# ADR 0009: Verification Letter PDF Generation — Typst

## Status

Accepted — 2026-08-19

## Context

`concept.md` requires PDF verification letters rendered on demand from
approved `HourEntry` data, never stored, with Foundation letterhead and
brand colors. `research-findings.md` recommended `@react-pdf/renderer`
for the original JS stack but flagged its PDF/UA (ISO 14289) tagging
support as unverified — a real gap, since WCAG 2.1 AA covers the web
application but not PDFs, and PDF accessibility requires separate PDF/UA
tagging that the concept.md spec did not address at all.

## Decision

Use **Typst**, driven programmatically via the `typst` crate (plus the
`typst-as-lib` wrapper for embedding Typst compilation in a Rust service,
and `typst-pdf` for PDF export), for verification letter generation.

Typst supports full **PDF/UA-1 tagged-PDF export natively**
(`--pdf-standard ua-1`), including alt-text and export-time accessibility
validation. This is a genuine Rust-path advantage, not merely parity with
the original plan: it directly closes the WCAG/PDF-accessibility gap that
`research-findings.md` flagged as unaddressed, and does so with a feature
the original recommendation (`@react-pdf/renderer`) does not support at
all — `@react-pdf/renderer` has no tagged-PDF export capability.

Implementation shape: the letter is a Typst template (Foundation
letterhead, brand colors per concept.md section 7: cream `#faf8f3`,
orange `#ff5a1f`, navy `#1a2a3a`, cyan `#5cb8e8`) populated with data
queried at request time from approved `HourEntry` rows (per
[[0006-assignment-event-model-and-hours-semantics]]'s constraint that
only `Contributor`-mode assignments can have hour entries at all — this
covers every `project`-type assignment plus an `event`-type assignment
belonging to that event's own lead/host, and excludes ordinary event
attendees), compiled to a PDF/UA-1 tagged PDF in-process by the Rust service, and streamed
directly in the HTTP response — never written to disk or object storage,
matching concept.md's "rendered on demand... never stored" requirement.

## Consequences

**Positive:**
- Closes a real, previously-unaddressed compliance gap (PDF/UA tagging)
  with a native capability rather than a workaround or secondary
  accessibility pass — this is the clearest case in the whole stack pivot
  where "Rust as much as possible" produces a better outcome than the
  original plan, not merely an equivalent one.
- No headless-browser dependency (unlike Puppeteer/Chromium-based
  approaches) — Typst compiles natively and fast, avoiding the cold-start
  latency risk `research-findings.md` flagged for serverless PDF
  rendering, which is doubly moot here since the Rust service is not
  serverless-per-request (see [[0012-hosting-and-deployment-topology]]).
- In-process compilation within the same Rust service that already holds
  the approved-hours query logic keeps "never store the generated
  letter" straightforward to guarantee — there's no separate rendering
  service or file-storage step where a stray persisted copy could leak.

**Negative / accepted risk:**
- Typst's PDF/UA-1 export is a newer capability; before Phase 6 ships,
  the actual generated output must be validated with a real PDF/UA
  conformance checker (e.g. veraPDF), not just trusted on the strength of
  the `--pdf-standard ua-1` flag existing — this is a named Phase 6 exit
  criterion already in build-roadmap.md and this ADR does not relax it.
- Typst template authoring is a smaller ecosystem than React/JSX-based
  PDF layout; brand-compliance review (exact colors, no em/en dashes)
  needs a human pass against the rendered output, same as any renderer,
  but with less existing tooling/community precedent to draw on.
- The `typst-as-lib` embedding wrapper is a smaller, less battle-tested
  crate than Typst itself — flagged as a dependency to watch for breaking
  changes given Typst's own continued active development.

## Alternatives Considered

- **`@react-pdf/renderer`** (original recommendation). Rejected — no
  tagged-PDF/PDF-UA support at all, meaning the WCAG/PDF-accessibility
  gap research-findings.md flagged would remain unaddressed regardless of
  language choice. Also not Rust, so doubly superseded by the pivot.
- **Puppeteer/headless-Chromium HTML-to-PDF, driven from Rust.** Rejected
  — reintroduces the cold-start/bundle-size concerns research-findings.md
  raised, is not a Rust-native solution, and still would not guarantee
  PDF/UA tagging without significant additional engineering.
- **A secondary accessibility-tagging pass after generation** (generate
  untagged PDF, then run a tagging tool). Rejected as unnecessary —
  Typst's native tagged export makes this extra step and its associated
  failure modes moot.

## Phase Gate

Unblocks Phase 6 (Verification Letters). Directly satisfies the Phase 6
exit criterion: "PDF/UA (ISO 14289) tagging is either confirmed supported
by the chosen library and enabled, or a documented alternative
accessibility approach is in place" — confirmed supported and enabled,
pending the veraPDF conformance validation named above.
