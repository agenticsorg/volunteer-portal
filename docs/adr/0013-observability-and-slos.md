# ADR-0013: Observability Stack (Sentry + OpenTelemetry + Structured Logging) and Production SLOs

## Status
Accepted — 2026-08-10

## Context
This platform is being built to a genuinely commercial-grade bar, not a prototype, and it carries real operational stakes even though it serves a nonprofit: hour-approval records feed grant reporting (funders require accurate, timestamped, supervisor-approved hours per `05-domain-and-compliance.md` §4), training completion gates compliance-relevant certifications, and moderation/audit trails must be reliable (`05-domain-and-compliance.md` checklist items 9 and 12: "audit trail on every privileged action"). A platform that silently fails hour approvals, drops badge-evaluation jobs, or loses moderation actions is not production-ready regardless of feature completeness.

The system also has several genuinely async, failure-prone integration points that need first-class visibility, not just "check the logs when someone complains": the Cloudflare Stream webhook pipeline (ADR-0010), the R2 upload/scan pipeline (ADR-0011), the domain-event outbox drained by graphile-worker across seven-plus schemas, and the Resend email pipeline (ADR-0012). Each of these is a place where a job can silently stop draining, a webhook can silently stop arriving, or a queue can silently back up — and because they're async, there's no synchronous request that fails loudly to surface the problem. Observability is the only way a small team catches these before a volunteer notices their hours never got approved.

The canonical stack already commits to Sentry, OpenTelemetry, structured JSON logging, and `/healthz` + `/readyz` endpoints; this ADR defines how they fit together and sets the concrete operational bar ("production ready") that a small team must still meet.

## Decision
**Sentry (error tracking) + OpenTelemetry (traces/metrics) + structured JSON logging form the observability stack, unified by a shared `traceId`/`requestId` correlation ID across all three, with concrete SLOs and an alerting strategy sized for a small operating team.**

### Stack roles (not redundant, each owns a distinct signal)
- **Sentry**: exception/error capture across Next.js (client + server), API routes, tRPC procedures, and graphile-worker jobs. Also used for release tracking (deploy markers) and performance transaction sampling for slow-request visibility at the request level.
- **OpenTelemetry**: distributed tracing and metrics — instruments the Next.js server, Prisma queries, outgoing HTTP calls (Cloudflare Stream API, R2, Resend, Supabase Auth), and graphile-worker job execution. Exported via OTLP to the observability backend (Sentry's OTel-compatible tracing ingestion, avoiding a second paid vendor for traces, unless/until scale demands a dedicated tracing backend like Honeycomb).
- **Structured JSON logging**: every log line is JSON with a fixed envelope (`timestamp`, `level`, `service`, `traceId`, `userId`/`subjectId` when applicable, `event`, plus context fields) — never free-text `console.log`. This is what powers audit-trail reconstruction and is the primary tool for the "what actually happened to this hour-entry/video/notification" debugging workflow.
- **Correlation**: every inbound request gets a `requestId` (propagated as `traceId` into OTel spans); every domain event and background job carries the originating `requestId` through the outbox so a graphile-worker log line can be traced back to the request/action that created the event it's processing.

### SLOs (production commercial-platform targets)
| Surface | SLO | Rationale |
|---|---|---|
| API (tRPC + REST `/api/v1`) p50 latency | < 150ms | Interactive UI responsiveness |
| API p95 latency | < 500ms | Interactive UI responsiveness under load |
| API p99 latency | < 1500ms | Bound worst-case for non-degenerate requests |
| Video signed-URL mint endpoint p95 | < 300ms | Directly blocks playback start; tighter than general API budget |
| Uptime (core app: auth, browse, hour-log, video playback) | 99.9% monthly (~43 min/mo budget) | Commercial-grade target without requiring multi-region active-active complexity |
| Error-rate budget (5xx / total requests) | < 0.5% rolling 1h, < 0.1% rolling 24h | Distinguishes transient blips from sustained regressions |
| Outbox drain lag (event `created_at` → `processed_at`) | p95 < 60s, hard alert at > 10 min | Async pipeline (notifications, badge eval, exports) must feel "immediate" to users even though it's decoupled |
| Webhook processing lag (Cloudflare Stream, Resend) | p95 < 30s from receipt to DB state update | Video-ready notification and bounce-driven preference updates must be timely |
| DSAR export fulfillment | < 72 hours from request to ready | Internal target well inside GDPR's statutory ~1 month response window, giving margin for review |

These are targets, not contractual guarantees to end users (no public status-page SLA is being published at this stage) — they exist to give the team a concrete definition of "healthy" to alert against and report on.

### Alerting strategy (sized for a small team — signal over noise)
- **Page-worthy (immediate, e.g. PagerDuty/OpsGenie or equivalent low-cost paging via Sentry alerts → phone push)**: error-rate budget breach (>0.5%/1h), uptime probe failure on core surfaces (`/healthz`/`/readyz` failing for >2 consecutive checks), outbox drain lag > 10 min, any 5xx spike on the hour-approval or auth path specifically (highest-consequence flows).
- **Ticket-worthy (next business day, e.g. a Slack/email digest → issue tracker)**: p95/p99 latency SLO breach sustained >1h, webhook processing lag breach, individual graphile-worker job failure rate elevated but not zero-throughput, elevated caption-review backlog (a training-content-ops signal, not an incident, but worth surfacing).
- **Dashboard-only (no alert, reviewed weekly)**: general traffic/usage trends, badge-evaluation throughput, email deliverability (bounce/complaint rate trend), R2 storage growth.
- Alert routing and on-call rotation is deliberately lightweight for a small team: a single rotating on-call owner (not a 24/7 multi-tier team), with Sentry/alert rules scoped tightly enough (per the "page-worthy" tier above) that paging stays rare and meaningful rather than a wall of noise that gets ignored — alert fatigue is treated as a correctness bug in the alerting config, not an acceptable cost.

### "Production ready" operational bar
Even for a small team, the platform is not considered production-ready without:
1. **Dashboards**: a primary "platform health" dashboard (request rate/latency/error-rate, outbox lag per schema, webhook lag, job failure rate) plus one dashboard per high-stakes flow (hour-approval funnel, video encode→publish funnel, DSAR export funnel) — built in Sentry/OTel-backed views so there is one pane of glass, not scattered vendor consoles.
2. **On-call/escalation**: a named on-call owner at all times (can rotate weekly among a small team), a documented escalation path if the primary owner doesn't acknowledge a page within a defined window (e.g., 15 min), and Sentry alert rules wired to that rotation rather than to a single hardcoded person.
3. **Incident runbook**: a living runbook (`docs/runbooks/`) with at minimum: how to check outbox drain health per schema, how to replay a stuck domain event, how to manually mark a video `ready`/`failed` if the Cloudflare webhook is lost, how to check Resend deliverability status, and a rollback procedure for a bad Vercel deploy. This ADR does not author the runbook itself but establishes that shipping without one is not "production ready."
4. **Release tracking**: every deploy tagged as a Sentry release (git SHA), so a spike in errors can be correlated to a specific deploy and rolled back with confidence rather than guessed at.
5. **Synthetic health checks**: `/healthz` (process liveness) and `/readyz` (DB connectivity, critical downstream reachability — Supabase Auth, R2, Cloudflare Stream API) are polled externally (e.g., a lightweight uptime-check service) so an outage is detected even if nobody happens to be looking at a dashboard.

## Consequences

### Positive
- Single correlation ID (`traceId`/`requestId`) threading through Sentry errors, OTel traces, and log lines means a production incident can be root-caused by following one ID across all three signal types, instead of manually cross-referencing timestamps across disconnected tools.
- Concrete, numeric SLOs give the small team an objective, arguable definition of "is this working" — replacing vibes-based "seems fine" assessments, which matters when funders/board members ask about platform reliability.
- Tiered alerting (page vs. ticket vs. dashboard) is explicitly designed to avoid alert fatigue for a small operating team, which is the realistic failure mode for any observability setup this team could actually sustain.
- Outbox-lag and webhook-lag as first-class SLOs directly target the platform's actual highest-risk failure mode (a silently-stalled async pipeline), rather than only watching synchronous request latency, which would miss it entirely.
- Sentry-as-OTel-backend avoids standing up and paying for a second tracing vendor while the platform is small, with a clear upgrade path (swap OTLP exporter target) if/when scale demands a dedicated tracing backend.

### Negative / Trade-offs
- Routing OTel traces through Sentry rather than a dedicated tracing backend (Honeycomb, Datadog) means less sophisticated trace-query/analysis tooling than a purpose-built system offers — acceptable trade at current scale, revisit if trace-query needs outgrow it.
- A single rotating on-call owner (not a follow-the-sun team) means real gaps in immediate coverage during the owner's off-hours — mitigated by keeping the page-worthy alert tier narrow and high-signal, but this is a genuine, accepted limitation of operating at nonprofit-team scale, not a solved problem.
- Maintaining structured-logging discipline (no stray `console.log`) across a TypeScript codebase requires an enforced lint rule and code-review discipline; without it the "audit trail reconstruction" value proposition erodes silently over time.
- SLOs add a small but real engineering cost: dashboards and alert rules must be built and maintained as new features (and new domain-event types) ship, or coverage drifts stale relative to what the platform actually does.

## Alternatives Considered
- **Datadog (unified APM + logs + traces)** — a strong, more turnkey alternative that would consolidate everything into one vendor with best-in-class dashboards. Rejected primarily on cost: Datadog's per-host/per-GB pricing model is significantly more expensive at any meaningful log/trace volume than Sentry (already committed to for error tracking) plus OTel's open, vendor-neutral instrumentation, and Datadog would be a second major recurring line item for a nonprofit-budget-constrained platform beyond what's already committed to (Cloudflare, Resend, Vercel, Neon/Supabase).
- **No dedicated tracing (Sentry errors + logs only, skip OpenTelemetry)** — rejected because the platform's highest-risk failure mode is specifically the async, multi-hop domain-event/webhook pipeline (upload → webhook → outbox → graphile-worker → notification), and error tracking alone cannot show *where time is going* across that hop chain, only that something eventually threw. Tracing is what makes "outbox drain lag" and "webhook processing lag" SLOs measurable in the first place; without it those SLOs would be unmeasurable claims.
- **Self-hosted Grafana/Prometheus/Loki stack** — rejected for the same reason self-hosted video (ADR-0010) and self-hosted anything else was rejected across this ADR set: real, ongoing operational burden (running and patching the stack itself) that a small team is not positioned to sustain, in exchange for cost savings that don't materialize until much higher scale than this platform currently operates at.

## Implementation Notes

**OpenTelemetry setup (Next.js, `instrumentation.ts`)**
```ts
import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({
    serviceName: "volunteer-portal",
    traceExporter: "otlp",
    // OTLP endpoint configured to Sentry's tracing ingestion (or a dedicated collector later)
  });
}
```

**Structured log envelope (shared logger module)**
```ts
type LogEnvelope = {
  timestamp: string;       // ISO 8601
  level: "debug" | "info" | "warn" | "error";
  service: string;         // 'api' | 'graphile-worker' | 'webhook-receiver'
  traceId?: string;
  requestId?: string;
  subjectId?: string;
  event: string;           // e.g. 'hour_entry.approved', 'video.webhook_received'
  context?: Record<string, unknown>;
};

export function log(entry: Omit<LogEnvelope, "timestamp">) {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
}
```

**Health endpoints**
```ts
// GET /healthz — liveness only, no downstream checks, must always be fast
export async function GET() {
  return Response.json({ status: "ok" }, { status: 200 });
}

// GET /readyz — checks DB + critical downstream reachability
export async function GET_ready() {
  const checks = await Promise.allSettled([
    db.$queryRaw`SELECT 1`,
    fetch(env.CF_STREAM_HEALTH_URL, { method: "HEAD" }),
    fetch(env.SUPABASE_AUTH_HEALTH_URL, { method: "HEAD" }),
  ]);
  const failed = checks.filter((c) => c.status === "rejected");
  return Response.json(
    { status: failed.length === 0 ? "ready" : "degraded", failed: failed.length },
    { status: failed.length === 0 ? 200 : 503 }
  );
}
```

**Outbox lag metric (emitted per drain cycle, per schema)**
```ts
async function reportOutboxLag(schemaName: string) {
  const [{ maxLagSeconds }] = await db.$queryRaw<{ maxLagSeconds: number }[]>`
    SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) AS "maxLagSeconds"
    FROM ${schemaName}.domain_events WHERE processed_at IS NULL
  `;
  otelMeter.createObservableGauge(`outbox.lag_seconds.${schemaName}`).addCallback((result) => {
    result.observe(maxLagSeconds ?? 0);
  });
  if (maxLagSeconds > 600) {
    Sentry.captureMessage(`Outbox drain lag exceeded 10min for ${schemaName}`, "error");
  }
}
```

**Sentry release tagging (CI/CD, GitHub Actions)**
```yaml
- name: Create Sentry release
  uses: getsentry/action-release@v1
  env:
    SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
    SENTRY_ORG: agentics-foundation
    SENTRY_PROJECT: volunteer-portal
  with:
    version: ${{ github.sha }}
    environment: production
```

**Runbook location**: `docs/runbooks/` (to be authored separately; this ADR establishes it as a launch requirement, not a nice-to-have). Minimum initial entries: outbox stuck/replay, video stuck in `processing`, Resend deliverability drop, bad-deploy rollback.
