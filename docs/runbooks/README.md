# Runbooks

Operational runbooks for the volunteer portal, established as a launch requirement by
ADR-0013 (`docs/adr/0013-observability-and-slos.md`, "'Production ready' operational
bar" item 3: "a living runbook (`docs/runbooks/`) ... this ADR does not author the
runbook itself but establishes that shipping without one is not 'production ready'").

Each runbook is written against the real, current codebase — real file paths, real
table/column names, real commands — and each one says explicitly where it depends on
something not yet provisioned in this environment (a live Sentry account, a live
Resend webhook subscription, real cloud/paging credentials) rather than implying it's
already working end-to-end.

## Incident runbooks

- [Check outbox drain health per schema](./outbox-drain-health.md) — diagnose a
  stalled/backing-up `<schema>.domain_events` outbox against ADR-0013's outbox-lag
  SLO (p95 < 60s, hard alert at > 10 min).
- [Replay a stuck domain event](./replay-stuck-domain-event.md) — safely force a
  stuck outbox row to be reprocessed without breaking either consumer shape's
  idempotency guarantee.
- [Manually mark a video ready/failed](./video-stuck-processing.md) — recover a
  training video stuck in `processing` when the Cloudflare Stream webhook is lost.
- [Check Resend deliverability status](./resend-deliverability.md) — diagnose
  transactional-email non-delivery via `delivery_attempt` and Resend's own
  dashboard/API.
- [Roll back a bad Vercel deploy](./vercel-rollback.md) — revert production/staging
  traffic to a known-good deployment and undo the git history that produced the bad
  one.

## Policy

- [On-call and alerting](./on-call-and-alerting.md) — ADR-0013's three alerting tiers
  (page-worthy / ticket-worthy / dashboard-only) and the on-call/escalation
  structure, with an explicit accounting of what's actually wired up in this
  environment versus what requires real paging/Sentry credentials to go live.

## Related

- ADR-0013 (`docs/adr/0013-observability-and-slos.md`) — the SLOs, alerting tiers,
  and stack decisions these runbooks operate against.
- ADR-0016 (`docs/adr/0016-hosting-and-infrastructure-topology.md`) — hosting
  topology and disaster-recovery/backup policy referenced by the rollback runbook.
- `packages/observability/` — the shared structured-logging, request-correlation,
  error-reporter, and outbox-lag-threshold code these runbooks reference throughout.
