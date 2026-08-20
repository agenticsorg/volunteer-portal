import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";

// Negative test (Phase 1 definition of done): proves the connection this
// app's own Prisma client actually uses — the real DATABASE_URL role,
// whatever it is in this environment — genuinely cannot mutate
// admin.audit_log. This must fail the mutation, not merely fail to prove
// anything: every assertion below expects the UPDATE/DELETE/TRUNCATE
// statement itself to throw, and then re-reads the row to confirm it is
// byte-for-byte unchanged (a caught exception alone isn't proof — a
// trigger could reject the statement after partially applying it, or the
// test could be catching an unrelated error).
//
// Per the migration's own comment (see
// apps/web/prisma/migrations/20260810191443_add_audit_log_and_domain_events/migration.sql),
// the role this repo connects as locally/in CI is a Postgres superuser, so
// the REVOKE grants alone would NOT stop this — it is the BEFORE
// UPDATE/DELETE/TRUNCATE trigger that must be doing the actual blocking.
// This test does not assume which mechanism is enforcing it; it only
// asserts the end result (mutation rejected, row unchanged), which is what
// actually matters.
describe("admin.audit_log is insert-only (negative test)", () => {
  const prisma = new PrismaClient();
  const rowIds: string[] = [];

  async function insertRow() {
    const id = newId();
    rowIds.push(id);
    await prisma.$executeRaw`
      INSERT INTO admin.audit_log (id, actor_id, actor_type, action, resource_type, resource_id, metadata)
      VALUES (${id}, 'actor-1', 'user', 'hour.approved', 'hour_entry', ${`resource-${id}`}, '{}'::jsonb)
    `;
    return id;
  }

  afterAll(async () => {
    // Cleanup can only ever be done by a superuser session bypassing RLS
    // is not applicable here — there is no DELETE path available at all,
    // by design. Deliberately leave the inserted rows in place; they are
    // harmless, uniquely IDed, and this is exactly the insert-only
    // behavior under test. (An attempt to DELETE them here would itself
    // be expected to fail, which would be a confusing thing to do in
    // cleanup.)
    await prisma.$disconnect();
  });

  it("rejects UPDATE and leaves the row unchanged", async () => {
    const id = await insertRow();
    const before = await prisma.auditLog.findUniqueOrThrow({ where: { id } });

    await expect(
      prisma.$executeRaw`UPDATE admin.audit_log SET action = 'tampered' WHERE id = ${id}`,
    ).rejects.toThrow(/insert-only/i);

    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(after).toEqual(before);
    expect(after.action).toBe("hour.approved");
  });

  it("rejects DELETE and leaves the row present", async () => {
    const id = await insertRow();

    await expect(
      prisma.$executeRaw`DELETE FROM admin.audit_log WHERE id = ${id}`,
    ).rejects.toThrow(/insert-only/i);

    const stillThere = await prisma.auditLog.findUnique({ where: { id } });
    expect(stillThere).not.toBeNull();
  });

  it("rejects TRUNCATE and leaves existing rows intact", async () => {
    const id = await insertRow();
    const countBefore = await prisma.auditLog.count();
    expect(countBefore).toBeGreaterThan(0);

    await expect(prisma.$executeRawUnsafe(`TRUNCATE admin.audit_log`)).rejects.toThrow(
      /insert-only/i,
    );

    const countAfter = await prisma.auditLog.count();
    expect(countAfter).toBe(countBefore);
    const stillThere = await prisma.auditLog.findUnique({ where: { id } });
    expect(stillThere).not.toBeNull();
  });

  it("still allows plain INSERT (the trigger targets mutation, not all writes)", async () => {
    const id = await insertRow();
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row.id).toBe(id);
  });
});
