# ADR 0010: Email Provider and Delivery Architecture

## Status

Accepted — 2026-08-19

## Context

`concept.md` requires five transactional email triggers (signup
confirmation, assignment approved, hours approved, meeting reminder,
verification letter ready) using the Agentics brand template system.
`research-findings.md` left Resend vs. Postmark open, noting Resend has
better Next.js/React-Email DX while Postmark has stronger deliverability
guarantees, and judged either sufficient for this volume. The Rust pivot
adds a delivery-mechanism question the original research didn't need to
answer: SMTP vs. HTTP API.

## Decision

**Delivery mechanism: HTTP API via `reqwest`, not SMTP/`lettre`.**
Rationale: common Rust hosting targets (see
[[0012-hosting-and-deployment-topology]] — Fly.io; also true of Railway,
which this ADR does not select but which the research pass notes blocks
outbound SMTP by default) increasingly restrict outbound SMTP, and
HTTP-API-based transactional email is the modern default pattern
regardless of hosting — most providers' own integration guidance leads
with HTTP APIs now, not SMTP.

**Provider: Postmark preferred; Resend as a strong, explicitly-endorsed
second choice.** Given this project's compliance context (verification
letters, hours records — see concept.md section 9's compliance floor and
[[0014-gdpr-article-27-representative]] /
[[0015-pipeda-breach-notification-and-privacy-officer]]), Postmark's
~98.7% inbox-placement guarantee and dedicated transactional-email focus
is the safer default, particularly for "verification letter ready" and
"hours approved" notifications where a volunteer not receiving an
expected email is a real user-facing failure, not a minor inconvenience.
Resend has an official Rust SDK (`resend-rs`) and is an acceptable
substitution if Postmark's pricing or onboarding proves a blocker in
practice — this ADR does not treat the choice as irreversible, since both
are accessed via the same `reqwest`-based HTTP-API pattern and swapping
providers is a contained change behind a single internal email-sending
trait/module.

Brand templates (concept.md section 7: cream `#faf8f3` background, orange
`#ff5a1f` CTAs, navy `#1a2a3a` cards, cyan `#5cb8e8` accent labels, no
palette substitutions, no em/en dashes) are authored as HTML email
templates (e.g. via a Rust templating crate such as `askama` or `minijinja`
for compile-time-checked template rendering) and passed to the provider's
send-API as rendered HTML, not composed via the provider's own template-
editor UI — keeping templates in version control alongside the rest of
the application.

## Consequences

**Positive:**
- HTTP-API delivery avoids the outbound-SMTP-blocking risk entirely,
  regardless of final hosting choice, and matches the pattern already
  used for Discord (`twilight-http`) and PDF-adjacent data flows —
  consistent `reqwest`-based integration style across the Rust backend.
- Postmark's deliverability guarantee reduces the risk of a volunteer
  silently not receiving a verification-letter-ready notification, which
  would be a poor experience for the exact document this system's
  differentiator (Phase 6) exists to produce.
- Templates-as-code (checked into the repo, compile-time-checked
  templating) keeps brand-compliance review (a named Phase 7 exit
  criterion) auditable via normal code review, rather than requiring a
  separate check of provider-hosted template UI state.

**Negative / accepted risk:**
- Postmark's free tier is smaller than Resend's; at low v1 volume (five
  triggers, one small nonprofit's volunteer base) this is not expected to
  be a binding constraint, but should be watched as the volunteer base
  grows.
- No official Rust SDK for Postmark was confirmed in the research pass
  (unlike Resend's `resend-rs`) — Postmark integration is a thin
  hand-rolled `reqwest` wrapper around its documented HTTP API. This is a
  small, contained amount of custom code, not a blocker, but is called
  out so it isn't mistaken for an existing, tested SDK.
- Delivery-failure handling (retry/log/alert, per build-roadmap.md's
  Phase 7 exit criteria) is not specified in detail here — deferred to
  Phase 7 implementation, but must be resolved before that phase is
  considered done, not left as a silent-failure gap.

## Alternatives Considered

- **Resend as primary.** Viable alternative; not chosen as primary
  because Postmark's deliverability guarantee is judged more valuable
  than Resend's superior Rust SDK given this project's compliance-
  sensitive email triggers. Documented here as the sanctioned fallback if
  Postmark proves impractical.
- **SMTP via `lettre`.** Rejected — outbound SMTP is blocked by default
  on common modern Rust-friendly hosts (Railway explicitly; a real risk
  on others), and HTTP APIs are the current default integration pattern
  for every major transactional-email provider regardless of hosting
  concerns.
- **Provider-hosted template editing (compose templates in Postmark/
  Resend's dashboard UI).** Rejected — moves brand-template source of
  truth outside version control, complicating the Phase 7 exit criterion
  that brand compliance be verified on every template as part of normal
  review.

## Phase Gate

Unblocks Phase 7 (Email). Also referenced by Phase 2 (signup
confirmation), Phase 3/4 (assignment/hours approved), and Phase 6
(verification letter ready) as the trigger-delivery mechanism those
phases' events fire through.
