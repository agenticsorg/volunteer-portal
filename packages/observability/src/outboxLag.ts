/**
 * Outbox-lag metric — the pure, DB-independent half of ADR-0013's
 * Implementation Notes `reportOutboxLag()` sketch: given the raw numbers a
 * `<schema>.domain_events` query already produced, decide the lag in
 * seconds and whether it breaches the "hard alert at > 10 min" SLO
 * (ADR-0013's SLO table: "Outbox drain lag ... p95 < 60s, hard alert at >
 * 10 min"). Kept separate from the actual SQL query (which apps/web wires
 * up in `server/observability/outboxLag.ts` against a real Prisma client,
 * and apps/worker could wire the same way against its `pg` connection) so
 * this threshold logic is testable with plain numbers — no live Postgres,
 * OTel, or Sentry backend required.
 */

/** ADR-0013 SLO table: "Outbox drain lag ... hard alert at > 10 min". */
export const OUTBOX_LAG_ALERT_THRESHOLD_SECONDS = 600;

export interface RawOutboxLagQuery {
  /** `EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))` over unprocessed rows, or `null` when there are none (nothing unprocessed = zero lag). */
  maxLagSeconds: number | null;
  /** Count of unprocessed rows this schema's `domain_events` table currently holds. */
  unprocessedCount: number;
}

export interface OutboxLagResult {
  schema: string;
  maxLagSeconds: number;
  unprocessedCount: number;
  /** `true` once `maxLagSeconds` exceeds the 10-minute hard-alert threshold. */
  needsAlert: boolean;
}

/** Turns a raw query result into the decided `OutboxLagResult` — pure, no I/O. */
export function evaluateOutboxLag(schema: string, raw: RawOutboxLagQuery): OutboxLagResult {
  const maxLagSeconds = raw.maxLagSeconds ?? 0;
  return {
    schema,
    maxLagSeconds,
    unprocessedCount: raw.unprocessedCount,
    needsAlert: maxLagSeconds > OUTBOX_LAG_ALERT_THRESHOLD_SECONDS,
  };
}
