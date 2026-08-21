# On-call and alerting policy

This document restates ADR-0013's alerting-tier and on-call/escalation policy
(`docs/adr/0013-observability-and-slos.md`, §"Alerting strategy" and §"'Production
ready' operational bar" item 2) as the operational reference, and states plainly what
is and is not actually wired up in this environment.

## Alerting tiers (verbatim from ADR-0013)

**Page-worthy (immediate, e.g. PagerDuty/OpsGenie or equivalent low-cost paging via
Sentry alerts → phone push)**: error-rate budget breach (>0.5%/1h), uptime probe
failure on core surfaces (`/healthz`/`/readyz` failing for >2 consecutive checks),
outbox drain lag > 10 min, any 5xx spike on the hour-approval or auth path specifically
(highest-consequence flows).

**Ticket-worthy (next business day, e.g. a Slack/email digest → issue tracker)**:
p95/p99 latency SLO breach sustained >1h, webhook processing lag breach, individual
graphile-worker job failure rate elevated but not zero-throughput, elevated
caption-review backlog (a training-content-ops signal, not an incident, but worth
surfacing).

**Dashboard-only (no alert, reviewed weekly)**: general traffic/usage trends,
badge-evaluation throughput, email deliverability (bounce/complaint rate trend), R2
storage growth.

## On-call / escalation structure

Per ADR-0013 §"Alerting strategy" and the "production ready" bar's item 2:

- **A single rotating on-call owner**, not a 24/7 multi-tier team — sized deliberately
  for this platform's small operating team (ADR-0013's Consequences: "a genuine,
  accepted limitation of operating at nonprofit-team scale, not a solved problem").
  The rotation is weekly among the team.
- **Escalation path**: if the primary on-call owner does not acknowledge a page within
  a defined window (ADR-0013 suggests 15 minutes as the example window), it escalates
  to a secondary/backup owner. The specific named individuals and the exact escalation
  tool configuration (who is primary this week, who is secondary) is operational
  roster information that belongs in the team's paging tool (PagerDuty/OpsGenie/
  Sentry's own on-call scheduling), not hardcoded into this repository — this doc
  defines the *policy shape*, the paging tool holds the *current roster*.
- **Alert rules must target the rotation, not a hardcoded individual** — per ADR-0013:
  "Sentry alert rules wired to that rotation rather than to a single hardcoded
  person." When the paging integration is actually configured (see below), point
  Sentry's alert-rule notification target at the on-call schedule/rotation object the
  paging tool exposes, not at one person's email/phone directly — otherwise the
  rotation is fictional and pages only ever reach whoever set it up.

## What is and is not actually live in this environment

**Live and real** (verifiable in this repository without any external account):
- The alerting *decision logic* for the one SLO this stage implements end-to-end —
  outbox drain lag > 10 min — is real, tested code:
  `evaluateOutboxLag`/`OUTBOX_LAG_ALERT_THRESHOLD_SECONDS`
  (`packages/observability/src/outboxLag.ts`) computes the breach; when it fires,
  `reportOutboxLag` (`apps/web/src/server/observability/outboxLag.ts`) calls
  `errorReporter.captureMessage(..., "error")` — the page-worthy signal this ADR
  calls for.
- The error-reporter adapter (`createErrorReporter`,
  `packages/observability/src/errorReporter.ts`, wired in
  `apps/web/src/server/observability/sentry.ts` and
  `apps/worker/src/observability/sentry.ts`) genuinely calls Sentry's real
  `captureException`/`captureMessage` **when `SENTRY_DSN` is set**, and safely
  no-ops (structured warning log, no network call, never throws) when it isn't —
  this environment has no `SENTRY_DSN`, so every alert-worthy event in this
  environment is currently only visible in structured logs, not in a live Sentry
  project.
- `/healthz` and `/readyz` (`apps/web/src/app/healthz/route.ts`,
  `apps/web/src/app/readyz/route.ts`) are real, callable endpoints today — but
  nothing in this environment polls them externally. An uptime-check service
  actually hitting these on an interval, and alerting on consecutive failures, is
  the missing piece, not the endpoints themselves.

**Not live — requires real account credentials this environment does not have**:
- No PagerDuty/OpsGenie account or equivalent paging service is provisioned or wired.
  There is no phone that actually rings when the outbox-lag threshold above fires.
- No Sentry project/DSN exists, so Sentry's own alert-rule engine (which the
  page-worthy/ticket-worthy tiers above assume for error-rate-budget and latency-SLO
  breaches specifically, per ADR-0013's Implementation Notes) is not configured at
  all — those two specific alert conditions (error-rate budget, p95/p99 latency)
  have no code path in this repository yet, because they depend on Sentry's own
  transaction/error aggregation rather than a query this codebase runs itself (unlike
  outbox lag, which this codebase computes directly against Postgres).
- No uptime-probe service (e.g. a third-party synthetic monitor) is configured
  against `/healthz`/`/readyz`.
- No Slack/email digest destination is wired for the ticket-worthy tier.
- The named on-call roster (who is primary/secondary this week) does not exist
  anywhere in this repository and should not be added here — it belongs in whatever
  paging tool is eventually provisioned, kept current by the team, not committed as
  static text that goes stale.

## What "provisioning this for real" requires

To move from "policy documented, decision logic implemented" to "actually paging a
human": provision a Sentry project and set `SENTRY_DSN` (and `SENTRY_AUTH_TOKEN` for
release tagging in CI, per ADR-0013's Implementation Notes sketch for
`getsentry/action-release`); provision a paging service and configure Sentry's alert
rules (or a direct webhook from this app's own alert triggers) to notify that
service's on-call schedule object; configure an external uptime monitor against
`/healthz` and `/readyz`; and establish the actual weekly rotation roster in that
paging service. None of this is code this repository can complete on its own — it
requires account-level decisions and credentials only the Agentics Foundation can
provision.
