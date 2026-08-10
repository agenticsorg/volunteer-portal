import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  ForbiddenActionError,
  grantRole,
  listActiveRoleAssignments,
  revokeRole,
  RoleAssignmentNotFoundError,
} from "@/modules/identity";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";

// Exercises GrantRole/RevokeRole (docs/ddd/identity-access.md Key Use
// Cases 2-3) against a real Postgres carrying the real `identity` schema,
// including the `can()` policy gate (ADR-0007) and the
// `uq_role_assignments_active` partial-unique-index-backed idempotency
// guarantee (RoleAssignment invariant 2).
describe("grantRole / revokeRole (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({
      where: { OR: [{ subjectId: { in: personIds } }, { grantedBy: { in: personIds } }] },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  it("an org_admin can grant a role at any scope, emitting RoleGranted", async () => {
    const admin = track((await createPerson(prisma)).id);
    const subject = track((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    const result = await grantRole(prisma, {
      callerId: admin,
      subjectId: subject,
      role: "mentor",
      scopeType: "global",
      scopeId: null,
    });
    expect(result.alreadyActive).toBe(false);

    const row = await prisma.roleAssignment.findUniqueOrThrow({ where: { id: result.roleAssignmentId } });
    expect(row).toMatchObject({ subjectId: subject, role: "mentor", scopeType: "global", grantedBy: admin });
    expect(row.revokedAt).toBeNull();

    const events = await prisma.identityDomainEvent.findMany({
      where: { aggregateType: "RoleAssignment", aggregateId: result.roleAssignmentId },
    });
    expect(events.map((e) => e.eventType)).toContain("RoleGranted");
  });

  it("re-granting an already-active role is a no-op, not a duplicate row (invariant 2)", async () => {
    const admin = track((await createPerson(prisma)).id);
    const subject = track((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    const first = await grantRole(prisma, {
      callerId: admin,
      subjectId: subject,
      role: "volunteer",
      scopeType: "global",
      scopeId: null,
    });
    const second = await grantRole(prisma, {
      callerId: admin,
      subjectId: subject,
      role: "volunteer",
      scopeType: "global",
      scopeId: null,
    });

    expect(second.roleAssignmentId).toBe(first.roleAssignmentId);
    expect(second.alreadyActive).toBe(true);

    const count = await prisma.roleAssignment.count({
      where: { subjectId: subject, role: "volunteer", revokedAt: null },
    });
    expect(count).toBe(1);
  });

  it("a chapter_lead can grant mentor/volunteer scoped to their own chapter, but not elsewhere", async () => {
    const admin = track((await createPerson(prisma)).id);
    const lead = track((await createPerson(prisma)).id);
    const subject = track((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
    await grantRoleDirect(prisma, {
      subjectId: lead,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: "chapter_london",
      grantedBy: admin,
    });

    const grantedInScope = await grantRole(prisma, {
      callerId: lead,
      subjectId: subject,
      role: "volunteer",
      scopeType: "chapter",
      scopeId: "chapter_london",
    });
    expect(grantedInScope.alreadyActive).toBe(false);

    await expect(
      grantRole(prisma, {
        callerId: lead,
        subjectId: subject,
        role: "volunteer",
        scopeType: "chapter",
        scopeId: "chapter_sv",
      }),
    ).rejects.toThrow(ForbiddenActionError);
  });

  it("a chapter_lead cannot grant org_admin/content_admin/moderator (invariant 4)", async () => {
    const admin = track((await createPerson(prisma)).id);
    const lead = track((await createPerson(prisma)).id);
    const subject = track((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
    await grantRoleDirect(prisma, {
      subjectId: lead,
      role: "chapter_lead",
      scopeType: "chapter",
      scopeId: "chapter_ldn2",
      grantedBy: admin,
    });

    await expect(
      grantRole(prisma, {
        callerId: lead,
        subjectId: subject,
        role: "content_admin",
        scopeType: "global",
        scopeId: null,
      }),
    ).rejects.toThrow(ForbiddenActionError);
  });

  it("a plain volunteer cannot grant any role", async () => {
    const volunteer = track((await createPerson(prisma)).id);
    const subject = track((await createPerson(prisma)).id);

    await expect(
      grantRole(prisma, {
        callerId: volunteer,
        subjectId: subject,
        role: "volunteer",
        scopeType: "global",
        scopeId: null,
      }),
    ).rejects.toThrow(ForbiddenActionError);
  });

  it("revokeRole sets revokedBy/revokedAt (no delete) and emits RoleRevoked", async () => {
    const admin = track((await createPerson(prisma)).id);
    const subject = track((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    const granted = await grantRole(prisma, {
      callerId: admin,
      subjectId: subject,
      role: "mentor",
      scopeType: "global",
      scopeId: null,
    });

    await revokeRole(prisma, { callerId: admin, roleAssignmentId: granted.roleAssignmentId });

    const row = await prisma.roleAssignment.findUniqueOrThrow({ where: { id: granted.roleAssignmentId } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedBy).toBe(admin);

    const active = await listActiveRoleAssignments(prisma, subject);
    expect(active.find((a) => a.id === granted.roleAssignmentId)).toBeUndefined();

    const events = await prisma.identityDomainEvent.findMany({
      where: { aggregateType: "RoleAssignment", aggregateId: granted.roleAssignmentId, eventType: "RoleRevoked" },
    });
    expect(events).toHaveLength(1);
  });

  it("revoking an unknown/already-revoked assignment throws RoleAssignmentNotFoundError", async () => {
    const admin = track((await createPerson(prisma)).id);
    await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

    await expect(
      revokeRole(prisma, { callerId: admin, roleAssignmentId: "role_does_not_exist" }),
    ).rejects.toThrow(RoleAssignmentNotFoundError);
  });
});
