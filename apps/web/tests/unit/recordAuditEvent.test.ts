import { describe, expect, it, vi } from "vitest";
import { isValidUlid } from "@volunteer-portal/ulid";
import {
  recordAuditEvent,
  type DomainEventsDelegate,
} from "@volunteer-portal/audit";

// Fakes the caller's own schema's `domain_events` Prisma model delegate
// (e.g. `tx.identityDomainEvent`) — recordAuditEvent() only ever needs
// `.create()` from it (see DomainEventsDelegate's doc comment), so a bare
// spy satisfies the whole contract without a real Prisma client.
function fakeDomainEventsDelegate() {
  const create = vi.fn().mockResolvedValue(undefined);
  return { create } satisfies DomainEventsDelegate;
}

describe("recordAuditEvent", () => {
  it("writes a single domain_events row with event_type = 'audit.recorded' and a ULID id", async () => {
    const tx = fakeDomainEventsDelegate();

    await recordAuditEvent(tx, {
      actorId: "actor-1",
      actorType: "user",
      action: "hour.approved",
      resourceType: "hour_entry",
      resourceId: "hour-1",
    });

    expect(tx.create).toHaveBeenCalledTimes(1);
    const { data } = tx.create.mock.calls[0][0];
    expect(data.eventType).toBe("audit.recorded");
    expect(isValidUlid(data.id)).toBe(true);
  });

  it("sets aggregateType/aggregateId to the audited resource, per ADR-0009's required domain_events columns", async () => {
    const tx = fakeDomainEventsDelegate();

    await recordAuditEvent(tx, {
      actorId: "actor-1",
      actorType: "user",
      action: "role.granted",
      resourceType: "role_assignment",
      resourceId: "role-1",
    });

    const { data } = tx.create.mock.calls[0][0];
    expect(data.aggregateType).toBe("role_assignment");
    expect(data.aggregateId).toBe("role-1");
  });

  it("tags the payload audit: true and includes every required field, for audit_log_writer's filter/contract", async () => {
    const tx = fakeDomainEventsDelegate();

    await recordAuditEvent(tx, {
      actorId: null,
      actorType: "system",
      action: "data.exported",
      resourceType: "dsar_request",
      resourceId: "dsar-1",
    });

    const { data } = tx.create.mock.calls[0][0];
    expect(data.payload).toEqual({
      audit: true,
      actorId: null,
      actorType: "system",
      action: "data.exported",
      resourceType: "dsar_request",
      resourceId: "dsar-1",
    });
  });

  it("includes optional fields (scope, before/after state, metadata) only when supplied", async () => {
    const tx = fakeDomainEventsDelegate();

    await recordAuditEvent(tx, {
      actorId: "actor-1",
      actorType: "user",
      action: "moderation.user_suspended",
      resourceType: "community_post",
      resourceId: "post-1",
      scopeType: "chapter",
      scopeId: "chapter-1",
      beforeState: { status: "visible" },
      afterState: { status: "hidden" },
      metadata: { reason: "spam" },
    });

    const { data } = tx.create.mock.calls[0][0];
    expect(data.payload).toMatchObject({
      scopeType: "chapter",
      scopeId: "chapter-1",
      beforeState: { status: "visible" },
      afterState: { status: "hidden" },
      metadata: { reason: "spam" },
    });
  });

  it("does not include scope/state/metadata keys at all when the caller omits them", async () => {
    const tx = fakeDomainEventsDelegate();

    await recordAuditEvent(tx, {
      actorId: "actor-1",
      actorType: "user",
      action: "hour.approved",
      resourceType: "hour_entry",
      resourceId: "hour-1",
    });

    const { data } = tx.create.mock.calls[0][0];
    expect(Object.keys(data.payload).sort()).toEqual(
      ["action", "actorId", "actorType", "audit", "resourceId", "resourceType"].sort(),
    );
  });

  it("generates a distinct id per call, so two audit events for the same resource never collide", async () => {
    const tx = fakeDomainEventsDelegate();
    const input = {
      actorId: "actor-1",
      actorType: "user" as const,
      action: "hour.approved",
      resourceType: "hour_entry",
      resourceId: "hour-1",
    };

    await recordAuditEvent(tx, input);
    await recordAuditEvent(tx, input);

    const firstId = tx.create.mock.calls[0][0].data.id;
    const secondId = tx.create.mock.calls[1][0].data.id;
    expect(firstId).not.toBe(secondId);
  });
});
