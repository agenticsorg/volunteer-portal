/**
 * @volunteer-portal/audit — recordAuditEvent()
 *
 * Every privileged action across all eight bounded contexts (hour
 * approval, role grant, DSAR completion, moderation action, ...) funnels
 * through this single helper (ADR-0014 §4), called inside the *same*
 * Prisma transaction as the privileged write it audits. Per ADR-0014's
 * Implementation Notes, this writes an `'audit.recorded'` event (payload
 * tagged `audit: true`) into the caller's own schema's `domain_events`
 * outbox table — never directly into another schema's table — so the
 * write path stays append-only and decoupled. The platform-wide
 * `audit_log_writer` graphile-worker consumer (apps/worker) later drains
 * every schema's outbox for `audit: true` events and appends them to the
 * single, shared `admin.audit_log` table (there is one audit log, not
 * eight — see ADR-0014 §"Alternatives Considered" and
 * docs/ddd/admin-reporting.md "There is one audit log, not two").
 */
import { newId } from "@volunteer-portal/ulid";

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
 * supplies (`id`, `occurred_at`) or that the drain worker doesn't
 * populate this phase (`ip_address`, `request_id` — see
 * apps/worker/src/tasks/audit-log-writer.ts).
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
 * The exact shape `recordAuditEvent()` writes to `domain_events.payload`
 * — `RecordAuditEventInput` plus the `audit: true` tag the drain worker
 * filters on (`payload @> '{"audit": true}'`). Exported so the drain-side
 * consumer (apps/worker's `audit_log_writer`) and tests can reference the
 * producer/consumer contract by type instead of re-declaring it.
 */
export interface AuditRecordedPayload extends RecordAuditEventInput {
  audit: true;
}

/**
 * The minimal shape `recordAuditEvent()` needs from the caller's own
 * schema's `domain_events` Prisma model delegate, obtained from *inside*
 * a `prisma.$transaction(async (tx) => { ... })` block — e.g.
 * `tx.identityDomainEvent`, `tx.volunteeringDomainEvent`, ... (one per
 * bounded-context schema; see apps/web/prisma/schema.prisma). Every one
 * of the eight per-schema `domain_events` models has this identical
 * column shape (ADR-0009), so this single structural interface is
 * satisfied by any of them — this package deliberately does not depend
 * on `@prisma/client` or know which of the eight schemas the caller
 * belongs to; the caller picks by choosing which delegate to pass. This
 * also means TypeScript verifies the wiring for free: passing the wrong
 * delegate, or a Prisma client that hasn't generated a `domain_events`
 * model, fails to typecheck at the call site.
 *
 * The caller is responsible for the transaction boundary — nothing here
 * calls `$transaction` itself, so this insert always participates in
 * whatever transaction `tx` was already scoped to.
 */
export interface DomainEventsDelegate {
  create(args: {
    data: {
      id: string;
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      // Typed `any`, deliberately, only here: Prisma's generated `create()`
      // requires its own `Prisma.InputJsonValue` (a recursive union
      // excluding `undefined`) for a `Json` column, which this package
      // cannot reference without depending on `@prisma/client` — the
      // exact coupling this structural interface exists to avoid (see
      // this interface's doc comment). Verified directly against the
      // real generated client (all eight `*DomainEventDelegate` types)
      // that this is the only field that needs the escape hatch; every
      // other field here is a plain `string` both sides agree on.
      payload: any;
    };
  }): Promise<unknown>;
}

/**
 * The Prisma transaction client the audited write is running in — see
 * `DomainEventsDelegate` above for the exact contract.
 */
export type AuditTransactionClient = DomainEventsDelegate;

/**
 * Records a privileged-action audit event, in the same transaction as
 * the write it audits.
 *
 * Writes one row to the caller's own schema's `domain_events` outbox
 * (`event_type = 'audit.recorded'`, `payload.audit = true`) — it never
 * writes to `admin.audit_log` directly, and never opens its own
 * transaction or connection. Because the insert lives in the caller's
 * transaction, the audit trail is guaranteed at-least-once (it commits
 * or rolls back atomically with the privileged write) and is never
 * silently dropped by a failed fire-and-forget call. Delivery into
 * `admin.audit_log` itself happens asynchronously, seconds later, via
 * the `audit_log_writer` outbox-drain worker (ADR-0014 §4's accepted
 * trade-off).
 *
 * The event's `aggregateType`/`aggregateId` (required, non-nullable
 * columns on every `domain_events` table — ADR-0009) are set to
 * `input.resourceType`/`input.resourceId`: the audited resource *is* the
 * aggregate this event pertains to.
 */
export async function recordAuditEvent(
  tx: AuditTransactionClient,
  input: RecordAuditEventInput,
): Promise<void> {
  const payload: Record<string, unknown> = { audit: true, ...input };

  await tx.create({
    data: {
      id: newId(),
      aggregateType: input.resourceType,
      aggregateId: input.resourceId,
      eventType: "audit.recorded",
      payload,
    },
  });
}
