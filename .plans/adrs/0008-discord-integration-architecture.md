# ADR 0008: Discord Integration Architecture

## Status

Accepted — 2026-08-19

## Context

`concept.md` specifies a role-sync bot (approved volunteer → base role,
project members → project role) run as a scheduled reconcile job rather
than real-time webhooks, plus notifications and a `/link` command.
`research-findings.md` confirmed the original discord.js design already
avoided the Vercel-serverless-vs-persistent-Gateway-bot problem by using
REST-only scheduled reconciliation. The Rust pivot needs an equivalent
crate decision, and build-roadmap.md's Phase 0 explicitly flags Discord
crate maturity as a candidate trigger for a TypeScript exception if the
Rust ecosystem can't cover it.

## Decision

Use **`twilight-http` + `twilight-model`**, not `serenity`.

Rationale: `serenity` defaults to full Gateway/WebSocket bot machinery —
event loops, shard management, presence/voice — none of which this
project needs, since the design is explicitly REST-only scheduled
reconciliation plus HTTP interaction handling (no persistent bot
process, per concept.md and confirmed by research-findings.md).
`twilight` is natively à la carte: `twilight-http` alone gives a REST
client with correct built-in Discord rate-limit handling, without pulling
in Gateway/shard infrastructure this project will never use.

**No TypeScript exception is needed for Discord** — this closes the
open question build-roadmap.md flagged in Phase 5's dependency note.
`twilight-http` fully covers the two things this project actually does:
scheduled REST reconciliation (role add/remove calls) and responding to
HTTP interaction webhooks (`/link` command).

**Concrete architecture:**
- **Role-sync reconcile job**: a scheduled Rust job (see
  [[0012-hosting-and-deployment-topology]] for where it runs) that, on
  each run, queries the current desired-role state from Postgres
  (approved volunteers → base role; project members via `assignment` →
  project-specific role) and reconciles it against Discord's actual guild
  member roles via `twilight-http` REST calls, adding/removing roles as
  needed. Idempotent by construction — re-running with no state change
  makes no API calls.
- **`/link` command**: Discord slash-command interactions arrive as HTTP
  POST webhooks to a dedicated Axum endpoint. Discord requires verifying
  the request signature before processing — this uses **`ed25519-dalek`**
  to verify the `X-Signature-Ed25519`/`X-Signature-Timestamp` headers
  against the interaction payload and the bot's public key, per Discord's
  documented interaction-security requirement. This signature check is
  required regardless of which Discord crate is used for the rest of the
  integration — it's a standalone cryptographic verification step, not
  something `twilight` or `serenity` provides.
- **Notifications** (DM/channel on assignment approved, hours approved,
  meeting reminders): sent via `twilight-http` REST calls
  (create-DM-channel + create-message), triggered from the relevant Rust
  handler (assignment approval, hours approval) or the scheduled
  reconcile job (meeting reminders), not a separate always-on listener.

## Consequences

**Positive:**
- No wasted dependency surface: `twilight-http` alone, without Gateway
  machinery, keeps the binary and its attack surface smaller than
  `serenity`'s default feature set would.
- Confirmed native Discord rate-limit handling means the reconcile job
  (which may make many role-update calls in a single run against a large
  roster) does not need hand-rolled backoff logic.
- Closes build-roadmap.md's Phase 5 open question decisively: Rust's
  Discord ecosystem is adequate for this project's actual scope, so no
  TypeScript exception is warranted here, keeping Discord integration
  inside the Rust core per [[0001-language-and-stack-strategy]].

**Negative / accepted risk:**
- `ed25519-dalek` signature verification is a discrete, easy-to-get-wrong
  security control (timing side channels, incorrect header parsing) that
  must be implemented once, correctly, and tested against Discord's
  documented interaction-verification test vectors before Phase 5 ships.
- `twilight` is more low-level than `serenity` by design — some
  conveniences (e.g. higher-level command frameworks) that `serenity`
  users may expect are not present; the reconcile job and `/link` handler
  are hand-rolled against the REST client directly.
- If a future version adds real-time Gateway event listening (explicitly
  out of scope for v1 per concept.md and research-findings.md), that
  would require adding `twilight-gateway` and a persistent-process
  hosting model — a nontrivial architecture change, not a config flag.
  Flagged here so it is a deliberate future ADR, not silent scope creep.

## Alternatives Considered

- **`serenity`.** Rejected — its default orientation toward
  Gateway/WebSocket bot machinery is a mismatch for a REST-only
  scheduled-reconcile design; would require fighting the crate's
  defaults to use it minimally.
- **TypeScript exception (`discord.js`) for the Discord integration
  layer only.** Considered per build-roadmap.md's explicit prompt to
  evaluate this. Rejected — `twilight-http` fully covers the actual
  scope (REST reconciliation + interaction webhooks), so there is no
  ecosystem-maturity gap forcing an exception here, unlike the frontend
  case in [[0011-frontend-architecture-typescript-exception]].

## Phase Gate

Unblocks Phase 5 (Discord bot). Resolves build-roadmap.md's explicit
Phase 5 dependency: "if the Rust Discord ecosystem cannot cover scheduled
REST reconciliation and slash-command interactions adequately, this is a
candidate for the sanctioned TypeScript exception" — decided here: it can,
so no exception is taken.
