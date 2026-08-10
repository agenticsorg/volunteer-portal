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

  it(
    "uq_role_assignments_active rejects two active global-scoped rows for the same " +
      "(subject, role) even bypassing grantRole's own pre-check (invariant 2, DB-level " +
      "backstop — global scope_id is NULL, so the index normalizes it via COALESCE)",
    async () => {
      const subject = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: subject, role: "org_admin", grantedBy: subject });

      await expect(
        grantRoleDirect(prisma, { subjectId: subject, role: "org_admin", grantedBy: subject }),
      ).rejects.toThrow(/Unique constraint failed/);
    },
  );

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

  // Reviewer-verified gap: privileged mutations never checked the
  // CALLER's own Person.status, so a suspended/anonymized account could
  // keep exercising privileged authority via a still-valid session as
  // long as its role_assignments themselves stayed active. These prove
  // `can()`'s own caller-status check (packages/authz/src/can.ts) in
  // isolation, directly mutating the caller's status rather than going
  // through requestErasure — dsar.integration.test.ts separately proves
  // the full erasure flow (which ALSO revokes the caller's own role
  // assignments) end to end.
  describe("caller status (fail-closed, independent of the target's own role assignments)", () => {
    it.each(["deactivated", "anonymized"] as const)(
      "grantRole denies a caller whose own status is %s, even though they still hold an active org_admin role_assignment",
      async (status) => {
        const admin = track((await createPerson(prisma)).id);
        await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
        const subject = track((await createPerson(prisma)).id);

        // chk_persons_anonymized_at requires anonymized_at set together
        // with status='anonymized' — set both so this update itself is a
        // valid row, isolating the assertion to can()'s caller-status
        // check rather than an unrelated CHECK violation.
        await prisma.person.update({
          where: { id: admin },
          data: { status, anonymizedAt: status === "anonymized" ? new Date() : null },
        });

        await expect(
          grantRole(prisma, {
            callerId: admin,
            subjectId: subject,
            role: "volunteer",
            scopeType: "global",
            scopeId: null,
          }),
        ).rejects.toThrow(ForbiddenActionError);

        // The rejection came from can()'s caller-status check, not
        // because the role assignment itself had somehow been revoked.
        const stillActive = await listActiveRoleAssignments(prisma, admin);
        expect(stillActive.some((a) => a.role === "org_admin")).toBe(true);
      },
    );

    it("revokeRole denies a caller whose own status is not active", async () => {
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const subject = track((await createPerson(prisma)).id);
      const granted = await grantRole(prisma, {
        callerId: admin,
        subjectId: subject,
        role: "mentor",
        scopeType: "global",
        scopeId: null,
      });

      await prisma.person.update({ where: { id: admin }, data: { status: "deactivated" } });

      await expect(
        revokeRole(prisma, { callerId: admin, roleAssignmentId: granted.roleAssignmentId }),
      ).rejects.toThrow(ForbiddenActionError);
    });

    it("grantRole resumes working once the caller's status is restored to active", async () => {
      const admin = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });
      const subject = track((await createPerson(prisma)).id);

      await prisma.person.update({ where: { id: admin }, data: { status: "deactivated" } });
      await expect(
        grantRole(prisma, {
          callerId: admin,
          subjectId: subject,
          role: "volunteer",
          scopeType: "global",
          scopeId: null,
        }),
      ).rejects.toThrow(ForbiddenActionError);

      await prisma.person.update({ where: { id: admin }, data: { status: "active" } });
      const result = await grantRole(prisma, {
        callerId: admin,
        subjectId: subject,
        role: "volunteer",
        scopeType: "global",
        scopeId: null,
      });
      expect(result.alreadyActive).toBe(false);
    });
  });
});
