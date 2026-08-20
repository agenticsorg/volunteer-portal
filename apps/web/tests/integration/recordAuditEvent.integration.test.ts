import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";

// Exercises recordAuditEvent() against a real Postgres transaction (ADR-0015
// §"Audit log writes": integration coverage, not a mocked Prisma client) —
// proving the two properties that matter most about it:
//   1. It writes a correctly-shaped `domain_events` row that
//      apps/worker's `audit_log_writer` drain query (see
//      apps/worker/src/tasks/audit-log-writer.ts) will actually pick up.
//   2. It has no transaction of its own — a caller-side rollback rolls
//      the audit event back with it, and a caller-side commit keeps it.
describe("recordAuditEvent (integration)", () => {
  const prisma = new PrismaClient();
  const resourceIds: string[] = [];

  afterAll(async () => {
    if (resourceIds.length > 0) {
      await prisma.identityDomainEvent.deleteMany({
        where: { aggregateId: { in: resourceIds } },
      });
    }
    await prisma.$disconnect();
  });

  it("commits an 'audit.recorded' domain_events row matching audit_log_writer's drain filter", async () => {
    const resourceId = `hour-${newId()}`;
    resourceIds.push(resourceId);

    await prisma.$transaction(async (tx) => {
      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: "actor-1",
        actorType: "user",
        action: "hour.approved",
        resourceType: "hour_entry",
        resourceId,
        scopeType: "chapter",
        scopeId: "chapter-1",
        beforeState: { status: "pending" },
        afterState: { status: "approved" },
        metadata: { note: "integration test" },
      });
    });

    // The exact WHERE clause audit_log_writer's drainSchema() selects with
    // (apps/worker/src/tasks/audit-log-writer.ts) — proves this row is
    // actually reachable by the real consumer, not just present.
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        processed_at: Date | null;
      }>
    >`
      SELECT id, aggregate_type, aggregate_id, event_type, payload, processed_at
        FROM identity.domain_events
       WHERE processed_at IS NULL
         AND payload @> '{"audit": true}'::jsonb
         AND aggregate_id = ${resourceId}
    `;

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.event_type).toBe("audit.recorded");
    expect(row.aggregate_type).toBe("hour_entry");
    expect(row.processed_at).toBeNull();
    expect(row.payload).toEqual({
      audit: true,
      actorId: "actor-1",
      actorType: "user",
      action: "hour.approved",
      resourceType: "hour_entry",
      resourceId,
      scopeType: "chapter",
      scopeId: "chapter-1",
      beforeState: { status: "pending" },
      afterState: { status: "approved" },
      metadata: { note: "integration test" },
    });
  });

  it("rolls back with the caller's own transaction — no orphaned audit row on failure", async () => {
    const resourceId = `hour-${newId()}`;
    resourceIds.push(resourceId);

    await expect(
      prisma.$transaction(async (tx) => {
        await recordAuditEvent(tx.identityDomainEvent, {
          actorId: "actor-1",
          actorType: "user",
          action: "hour.approved",
          resourceType: "hour_entry",
          resourceId,
        });
        throw new Error("simulated failure in the caller's own privileged write");
      }),
    ).rejects.toThrow("simulated failure");

    const count = await prisma.identityDomainEvent.count({
      where: { aggregateId: resourceId },
    });
    expect(count).toBe(0);
  });

  it("writes into the caller-selected schema's own domain_events table, not a fixed one", async () => {
    const resourceId = `role-${newId()}`;

    await prisma.$transaction(async (tx) => {
      await recordAuditEvent(tx.volunteeringDomainEvent, {
        actorId: null,
        actorType: "service_job",
        action: "role.granted",
        resourceType: "role_assignment",
        resourceId,
      });
    });

    const inVolunteering = await prisma.volunteeringDomainEvent.count({
      where: { aggregateId: resourceId },
    });
    const inIdentity = await prisma.identityDomainEvent.count({
      where: { aggregateId: resourceId },
    });
    expect(inVolunteering).toBe(1);
    expect(inIdentity).toBe(0);

    await prisma.volunteeringDomainEvent.deleteMany({ where: { aggregateId: resourceId } });
  });
});
