# ADR 0011: Frontend Architecture — TypeScript as the Sanctioned Exception

## Status

Accepted — 2026-08-19

## Context

This is the single decision in the entire stack pivot that most directly
tests the "Rust as much as possible" mandate, and per the rust-ecosystem
research pass it must be documented as an explicit, deliberate partial
departure — not softened, not buried in a table.

Three Rust-native frontend frameworks exist: Leptos, Yew, Dioxus (web-SSR
target). The alternative is a thin TypeScript frontend (Next.js or
SvelteKit) consuming the Rust/Axum API.

## Decision

**The frontend is TypeScript** (Next.js or SvelteKit — either is
acceptable; the specific pick is a Phase 1 implementation detail, not an
architectural fork, since both consume the same generated API types and
neither has a load-bearing advantage over the other for this app's
needs). **Not** Leptos, Yew, or Dioxus.

This is a genuine, explicit partial departure from "Rust as much as
possible," made for the following reasons, none of which is "Rust can't
render a web page":

1. **Leptos governance risk.** Leptos's sole lead maintainer publicly
   stepped back in May 2026 — the project is now described as "lightly
   maintained" with no 1.0 commitment. For a commercial-grade,
   multi-year application, betting the entire frontend on a framework
   with unresolved maintainership is a disqualifying governance risk,
   independent of its technical merits at the time of this research.
2. **Dioxus web-SSR immaturity.** Dioxus's web-SSR rendering path is
   still pre-1.0 with recently observed SSR-correctness bugs — not yet a
   stable foundation for a production application with real users and
   compliance obligations.
3. **Yew's stalled momentum.** Yew is stable but has lost ecosystem
   momentum — fewer active maintainers, slower issue resolution, thinner
   third-party component ecosystem than a framework still under active
   growth.
4. **The real blocker: the accessible-component ecosystem gap, not
   accessibility tooling.** It is important to be precise about what is
   and is not the problem. Automated accessibility testing (axe-core,
   Playwright) works identically against WASM-rendered DOM output as
   against React-rendered DOM — there is no tooling deficiency on that
   front. The actual blocker is that React's accessible-component
   libraries — **Radix UI** (19,186 GitHub stars) and **React Aria**
   (15,801 stars) — represent years of professionally-hardened,
   battle-tested focus-management, ARIA-live-region, and form-label
   engineering that this project would otherwise have to reinvent. The
   Rust-ecosystem equivalents are single-team side projects with fewer
   than 25 stars, and the one notable attempt at a cross-framework Rust
   port of Radix's primitives is already archived and unmaintained. For a
   WCAG 2.1 AA application with bulk-approval queues (Phase 4) and
   multi-field forms (Phase 2 onboarding), building this primitive layer
   from scratch is an unbudgeted, high-risk tax landing exactly where
   accessibility defects are most costly and least excusable — a
   volunteer-facing nonprofit application with an explicit WCAG
   compliance requirement (concept.md section 9) cannot treat this as an
   acceptable place to under-invest.

**Contract-drift mitigation:** the Rust/TypeScript boundary is bridged by
generating TypeScript types directly from Rust request/response types
using **`ts-rs`** or **`specta`** (final pick is a Phase 1 implementation
detail), rather than hand-maintaining a duplicate TypeScript API contract.
This is generated as part of the Rust build and consumed by the frontend
build, so a change to a Rust handler's request/response shape that isn't
reflected in the frontend fails to type-check rather than failing
silently at runtime.

## Consequences

**Positive:**
- Avoids betting a compliance-critical, multi-year commercial application
  on a framework (Leptos) with an unresolved leadership/governance
  question, or on a pre-1.0 SSR path (Dioxus) with known correctness
  bugs.
- Inherits React's mature accessible-component ecosystem (Radix UI /
  React Aria) directly, which is the highest-leverage way to actually hit
  the WCAG 2.1 AA bar concept.md requires, rather than spending scarce
  engineering time reimplementing focus management and ARIA semantics
  that are already solved problems in the React ecosystem.
- Generated types (`ts-rs`/`specta`) keep the API contract single-sourced
  from the Rust backend, substantially reducing (though not eliminating)
  the two-language-stack drift risk.

**Negative / accepted risk — stated plainly, per the user's mandate:**
- This is the project's clearest, most consequential departure from
  "Rust as much as possible." It must not be minimized in retrospectives
  or future architecture discussions: the frontend is TypeScript because
  the Rust-native alternatives carry governance, maturity, and
  ecosystem risks judged unacceptable for this specific application's
  requirements — not because Rust frontend frameworks are categorically
  unviable for all projects.
- Two languages means two build toolchains, two sets of dependencies to
  keep patched, and a real (if mitigated) risk of contract drift between
  the Rust API and TypeScript frontend, particularly for any manual
  frontend logic that doesn't route through the generated types (e.g.
  client-side validation duplicating server-side rules).
- This decision should be revisited if Leptos's governance situation
  resolves favorably (e.g. a credible maintainership transition) or if
  Dioxus's web-SSR path reaches a stable 1.0 with the accessible-
  component gap meaningfully closed — but not before, and not on the
  strength of "Rust would be nicer," absent that ecosystem gap closing.

## Alternatives Considered

- **Leptos.** Rejected on governance risk (see above), independent of
  its otherwise-strong technical design (fine-grained reactivity, SSR
  support).
- **Dioxus.** Rejected on web-SSR maturity (pre-1.0, recent SSR-
  correctness bugs) for this application's production timeline.
- **Yew.** Rejected on ecosystem momentum, not technical soundness — Yew
  is stable, but a stalled ecosystem compounds the accessible-component
  gap rather than mitigating it.
- **Hand-rolled accessible components in a Rust-native framework,
  accepting the reinvestment cost.** Considered seriously, given the
  project's Rust-first mandate. Rejected because the cost is not merely
  "more work" — it is specifically the kind of work (focus management,
  ARIA semantics, screen-reader edge cases) where subtle defects are
  hard to catch in review and directly harm the population (volunteers
  using assistive technology) this compliance requirement exists to
  protect. Not an acceptable place to be the first mover.

## Phase Gate

Unblocks Phase 1 (Foundation — frontend scaffold choice) and every
subsequent phase's UI work (Phases 2-4, 6, 8-10 all have frontend
surfaces). Satisfies build-roadmap.md's Phase 0 exit criterion that "the
Rust/TypeScript split is stated per-component... not just 'mostly Rust.'"
