/**
 * @volunteer-portal/audit — recordAuditEvent()
 *
 * Every privileged action across all eight bounded contexts (hour
 * approval, role grant, DSAR completion, moderation action, ...) funnels
 * through this single helper (ADR-0014 §4), called inside the *same*
 * Prisma transaction as the privileged write it audits. The real
 * implementation writes an `'audit.recorded'` event (payload tagged
 * `audit: true`) into the caller's own schema's `domain_events` outbox
 * table — never directly into another schema's table — so the write path
 * stays append-only and decoupled. The platform-wide `audit_log_writer`
 * graphile-worker consumer later drains every schema's outbox for
 * `audit: true` events and appends them to the single, shared
 * `admin.audit_log` table (there is one audit log, not eight — see
 * ADR-0014 §"Alternatives Considered" and docs/ddd/admin-reporting.md
 * "There is one audit log, not two").
 *
 * STUB — Phase 0 (platform bootstrap) establishes this package's public
 * shape and signature only, so every module can import and call it with
 * the correct types today and no call site needs to change when Phase 1
 * ("Event Backbone & Platform Audit Log") supplies the real
 * outbox-writing implementation, once every schema's `domain_events`
 * table exists.
 */

/** Who performed the action — mirrors `admin.audit_log.actor_type`. */
export type AuditActorType = "user" | "system" | "service_job";

/**
 * Mirrors `identity.role_assignments` scoping — set when the audited
 * action was scoped to a single chapter rather than platform-wide.
 */
export type AuditScopeType = "chapter" | "global";

/**
 * Input to `recordAuditEvent()`. Matches `admin.audit_log`'s columns
 * (ADR-0014 §4), minus the fields the recording infrastructure itself
 * supplies (`id`, `occurred_at`, `ip_address`, `request_id`).
 */
export interface RecordAuditEventInput {
  /** `identity.users.id` of who did it; `null` for system-initiated jobs. */
  actorId: string | null;
  actorType: AuditActorType;
  /** e.g. `"hour.approved"`, `"role.granted"`, `"data.exported"`. */
  action: string;
  /** e.g. `"hour_entry"`, `"role_assignment"`, `"dsar_request"`. */
  resourceType: string;
  /** The affected resource's id — a plain ULID reference, never a FK. */
  resourceId: string;
  scopeType?: AuditScopeType;
  scopeId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * The Prisma transaction client the audited write is running in.
 *
 * Deliberately typed as an opaque placeholder rather than importing
 * `@prisma/client`'s generated `Prisma.TransactionClient` here: Phase 0
 * only creates the eight empty schemas (no `domain_events` model exists
 * yet for this package to depend on — see ADR-0001, ADR-0004). Phase 1
 * narrows this to the real generated transaction-client type once every
 * schema's `domain_events` table exists.
 */
export type AuditTransactionClient = unknown;

/**
 * Records a privileged-action audit event, in the same transaction as
 * the write it audits.
 *
 * NOT YET IMPLEMENTED. Always throws in Phase 0 — see ADR-0014 §4 and
 * `docs/plans/implementation-plan.md` Phase 1 (Event Backbone & Platform
 * Audit Log) for the real implementation.
 */
export async function recordAuditEvent(
  tx: AuditTransactionClient,
  input: RecordAuditEventInput,
): Promise<void> {
  void tx;
  void input;
  throw new Error(
    "recordAuditEvent() is not implemented yet: Phase 0 (platform " +
      "bootstrap) establishes this package's shape and signature only. " +
      "See ADR-0014 §4 and docs/plans/implementation-plan.md Phase 1 " +
      "(Event Backbone & Platform Audit Log) for the real implementation.",
  );
}
