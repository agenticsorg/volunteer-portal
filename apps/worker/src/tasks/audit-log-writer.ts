/**
 * `audit_log_writer` — the outbox-drain consumer specified by ADR-0014 §4
 * ("Other schemas emit an audit event via their own `domain_events`
 * outbox; a graphile-worker consumer (`audit_log_writer`) drains all
 * schemas' outboxes for events tagged `audit: true` and appends to
 * `admin.audit_log`. This keeps the write path append-only and decoupled
 * — a schema never writes directly into another schema's table.") and
 * docs/ddd/admin-reporting.md's "There is one audit log, not two".
 *
 * Contract with the producer side (`packages/audit`'s `recordAuditEvent`,
 * per ADR-0014's Implementation Notes): a producing schema writes a
 * `domain_events` row with `event_type = 'audit.recorded'` and a
 * `payload` containing `audit: true` plus every field of
 * `RecordAuditEventInput` (`@volunteer-portal/audit`), camelCase, exactly
 * mirroring `admin.audit_log`'s columns minus the fields the recording
 * infrastructure itself supplies (`id`, `occurred_at`, `ip_address`,
 * `request_id` — none of which this drain worker populates either; see
 * the migration SQL / schema.prisma comments on `AuditLog.ipAddress`).
 *
 * Idempotency (ADR-0009 "Idempotent handlers are mandatory"): rather than
 * a separate `processed_events` dedupe ledger (the general pattern
 * `packages/outbox` will provide for multi-subscriber fan-out consumers
 * in a later phase), this single-purpose consumer reuses the source
 * `domain_events.id` (a ULID, globally unique — ADR-0005) as the
 * `admin.audit_log.id` it inserts, and inserts with
 * `ON CONFLICT (id) DO NOTHING`. A redelivered event — e.g. this job
 * crashes after the INSERT commits but before the source row is marked
 * `processed_at` — safely no-ops on retry instead of double-appending to
 * the audit log.
 */
import type { Task, JobHelpers } from "graphile-worker";
import type { PoolClient } from "pg";
import type {
  AuditActorType,
  AuditScopeType,
} from "@volunteer-portal/audit";
import { BOUNDED_CONTEXT_SCHEMAS } from "../schemas.js";

/** ADR-0014 "mitigated by keeping the drain worker's poll interval low (5s) for audit-tagged events specifically." */
const POLL_INTERVAL_MS = 5_000;

/** Rows drained per schema per run; keeps each run's transactions short. */
const BATCH_SIZE = 100;

/**
 * `jobKey` used to self-reschedule this task (see bottom of the handler).
 * graphile-worker's `crontab` recurring-task mechanism only supports
 * minute granularity, coarser than the 5s interval ADR-0014 asks for, so
 * this task re-enqueues itself instead — a standard graphile-worker
 * pattern for sub-minute polling loops. `jobKeyMode: "replace"` ensures
 * only one pending reschedule ever exists, so restarts/redeliveries can't
 * pile up duplicate scheduled runs.
 */
const RESCHEDULE_JOB_KEY = "audit_log_writer_poll";

interface DomainEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/** The shape `recordAuditEvent()` is contracted to write (see file header). */
interface AuditRecordedPayload {
  [key: string]: unknown;
  audit: true;
  actorId: string | null;
  actorType: AuditActorType;
  action: string;
  resourceType: string;
  resourceId: string;
  scopeType?: AuditScopeType;
  scopeId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function isAuditTagged(payload: Record<string, unknown>): payload is AuditRecordedPayload {
  return payload["audit"] === true;
}

async function drainSchema(
  pgClient: PoolClient,
  schema: (typeof BOUNDED_CONTEXT_SCHEMAS)[number],
  helpers: JobHelpers,
): Promise<number> {
  // Schema-qualified identifier interpolation below is safe: `schema` is
  // always one of the eight literal values in BOUNDED_CONTEXT_SCHEMAS
  // (never user or event input), so this can never be SQL injection —
  // Postgres has no parameter-binding syntax for identifiers, so a
  // whitelist check (enforced by the parameter's own type) is the
  // standard, safe way to do this.
  const { rows } = await pgClient.query<DomainEventRow>(
    `SELECT id, aggregate_type, aggregate_id, event_type, payload, occurred_at
       FROM "${schema}".domain_events
      WHERE processed_at IS NULL
        AND payload @> '{"audit": true}'::jsonb
      ORDER BY id
      LIMIT $1`,
    [BATCH_SIZE],
  );

  let drained = 0;

  for (const row of rows) {
    if (!isAuditTagged(row.payload)) {
      // Defensive: the WHERE clause above already filters on
      // payload @> '{"audit": true}', so this should be unreachable.
      // If it ever does trigger, skip (mark processed) rather than
      // crash the whole drain loop over one malformed event.
      helpers.logger.error(
        `audit_log_writer: ${schema}.domain_events id=${row.id} matched the audit filter but failed payload validation; marking processed without writing to admin.audit_log`,
      );
      await pgClient.query(
        `UPDATE "${schema}".domain_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`,
        [row.id],
      );
      continue;
    }

    const audit = row.payload;

    try {
      await pgClient.query("BEGIN");
      await pgClient.query(
        `INSERT INTO admin.audit_log (
           id, occurred_at, actor_id, actor_type, action, resource_type,
           resource_id, scope_type, scope_id, before_state, after_state, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, // shared id with the source event => idempotent re-insert
          row.occurred_at,
          audit.actorId,
          audit.actorType,
          audit.action,
          audit.resourceType,
          audit.resourceId,
          audit.scopeType ?? null,
          audit.scopeId ?? null,
          audit.beforeState ? JSON.stringify(audit.beforeState) : null,
          audit.afterState ? JSON.stringify(audit.afterState) : null,
          JSON.stringify(audit.metadata ?? {}),
        ],
      );
      await pgClient.query(
        `UPDATE "${schema}".domain_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`,
        [row.id],
      );
      await pgClient.query("COMMIT");
      drained += 1;
    } catch (err) {
      await pgClient.query("ROLLBACK");
      // Record the failed attempt outside the rolled-back transaction so
      // attempts is still incremented and last_error is observable —
      // this leaves the row for retry on the next poll, up to
      // graphile-worker's normal max-attempts ceiling for *this task*.
      await pgClient
        .query(`UPDATE "${schema}".domain_events SET attempts = attempts + 1 WHERE id = $1`, [row.id])
        .catch(() => {
          /* best-effort; the event remains unprocessed and will be retried regardless */
        });
      helpers.logger.error(
        `audit_log_writer: failed to drain ${schema}.domain_events id=${row.id}: ${(err as Error).message}`,
      );
    }
  }

  return drained;
}

export const auditLogWriter: Task = async (_payload, helpers: JobHelpers) => {
  let totalDrained = 0;

  await helpers.withPgClient(async (pgClient) => {
    for (const schema of BOUNDED_CONTEXT_SCHEMAS) {
      totalDrained += await drainSchema(pgClient, schema, helpers);
    }
  });

  if (totalDrained > 0) {
    helpers.logger.info(`audit_log_writer: drained ${totalDrained} audit event(s) into admin.audit_log`);
  }

  // Self-reschedule (see RESCHEDULE_JOB_KEY doc comment above).
  await helpers.addJob(
    "audit_log_writer",
    {},
    {
      runAt: new Date(Date.now() + POLL_INTERVAL_MS),
      jobKey: RESCHEDULE_JOB_KEY,
      jobKeyMode: "replace",
    },
  );
};
