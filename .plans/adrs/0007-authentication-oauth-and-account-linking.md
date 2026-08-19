# ADR 0007: Authentication, OAuth Providers, and Account-Linking Policy

## Status

Accepted — 2026-08-19

## Context

`concept.md` specifies Discord OAuth as primary login, Google as fallback,
no password signup. `research-findings.md` flags that Auth.js's
`allowDangerousEmailAccountLinking` is unsafe by default and the original
spec did not decide whether Discord+Google accounts sharing an email
should auto-link. That decision carries forward unchanged into the Rust
pivot — it is a product/security decision, not a library detail — except
that there is no Auth.js in this stack at all: the Rust ecosystem has no
equivalent account-linking layer, per the research pass. This is genuine
custom application code, not configuration of an existing library.

## Decision

**Libraries:** `oauth2` crate for Discord's OAuth2 flow, `openidconnect`
for Google (full OIDC, including ID-token verification — Google's OIDC
discovery document and JWKS, not a bare OAuth2 token exchange).
`tower-sessions` for session storage/plumbing, backed by the Neon
Postgres database (a `tower-sessions` Postgres store), avoiding a
separate Redis dependency for v1. `jsonwebtoken` only if a signed
short-lived token is needed for the Discord `/link` interaction flow (see
[[0008-discord-integration-architecture]]) — not for primary session
management, which uses server-side sessions via `tower-sessions`, not
client-held JWTs.

**Account-linking policy: manual, explicit confirmation — never automatic
email-match linking.**

Concretely:
- Each OAuth identity (Discord, Google) is stored as its own row in an
  `identity` table: `volunteer_id`, `provider`, `provider_user_id`,
  `email`, `email_verified` (boolean, captured from the provider at
  link time — Discord's `verified` field for its account email, Google's
  `email_verified` OIDC claim), `linked_at`.
- On first login via either provider, if no existing `identity` row
  matches `(provider, provider_user_id)`, the system checks whether any
  existing `volunteer` has a *verified* identity with the same email. If
  so, the new login is **not** auto-linked. Instead, the user is shown an
  explicit prompt: "An account with this email already exists, linked via
  [Discord/Google]. Sign in with that provider, then link this one from
  your account settings." A signed-in user can then initiate linking
  from their own account settings, which re-authenticates via the second
  provider's OAuth flow and only links if that flow succeeds — the user
  is proving control of both identities in the same authenticated
  session, not relying on email string equality alone.
- `email_verified = false` identities (should the provider ever surface
  one) are never used as a linking signal at all, regardless of whether
  the user is present — an unverified email claimed by an OAuth provider
  is not proof of ownership.
- No `allowDangerousEmailAccountLinking`-equivalent flag exists in this
  design because there is no default auto-linking path to disable — the
  manual flow is the only flow.

## Consequences

**Positive:**
- Closes the exact account-takeover vector research-findings.md flagged:
  an attacker who controls a Google account with the same email as a
  victim's Discord-linked volunteer account cannot silently merge into
  the victim's account merely by signing in — they must already be
  signed in as the victim to initiate linking.
- Storing `email_verified` per identity, not just a single email on
  `Volunteer`, makes the verification state auditable and queryable
  later (e.g. for a future security review) rather than implicit.
- Manual linking is explainable to a non-technical volunteer in a single
  UI prompt, and matches concept.md's stated `/link` command flow for
  Discord already being an explicit, deliberate action rather than an
  automatic one.

**Negative / accepted risk:**
- This is entirely hand-rolled: there is no Auth.js-equivalent library in
  Rust providing account-linking, session refresh, and provider-abstraction
  out of the box. Budget real engineering and security-review time here —
  the research pass calls this out explicitly as genuine implementation
  risk, not a solved problem in Rust, and this ADR does not make that risk
  disappear, only scopes it.
- Manual linking adds one extra user-facing step (sign in with the first
  provider, then explicitly link the second) compared to silent
  auto-linking — a minor UX cost accepted in exchange for the security
  property.
- `openidconnect`'s ID-token verification (JWKS fetch/cache, signature
  and claims validation) must be implemented and kept correct; a bug here
  (e.g. not validating `aud`/`iss`/`exp`) reopens the exact class of risk
  this ADR is trying to close. This is a specific, named review item for
  Phase 1/2 security review.

## Alternatives Considered

- **Automatic email-based linking.** Rejected — this is precisely the
  unsafe-by-default pattern research-findings.md flagged in Auth.js, and
  nothing about moving to Rust changes the underlying security argument
  against it.
- **No linking at all — Discord and Google always create separate
  volunteer records.** Rejected — concept.md's onboarding flow assumes a
  single volunteer identity that can authenticate via either provider
  (e.g. someone who signs up via Google and later wants Discord role-sync
  to recognize them, or vice versa); disallowing linking entirely would
  force duplicate onboarding and break Discord role-sync's assumption of
  one Discord ID per volunteer.
- **JWT-based stateless sessions instead of `tower-sessions` server-side
  sessions.** Rejected for primary session management — server-side
  sessions are simpler to revoke immediately (needed for e.g. an admin
  disabling a volunteer's access), whereas stateless JWTs require a
  revocation-list mechanism to achieve the same, adding complexity for no
  clear benefit at this scale.

## Phase Gate

Unblocks Phase 1 (Foundation — Discord OAuth round-trip) and Phase 2
(Onboarding — "account-linking policy from Phase 0 is implemented and has
a test proving the unsafe case cannot happen," per build-roadmap.md's
explicit Phase 2 exit criterion).
