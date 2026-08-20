import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantRole, recordConsent, registerPerson, requestErasure } from "@/modules/identity";
import type { VerifiedSupabaseSession } from "@/server/auth/verified-session";
import { newId } from "@volunteer-portal/ulid";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";

/**
 * Spot-checks that identity's Key Use Cases genuinely produce an
 * audit-tagged event that the real `audit_log_writer` graphile-worker
 * consumer (the same process `pnpm worker:start` runs) drains into
 * `admin.audit_log` — not just that `recordAuditEvent()` was called (that
 * much is proven per-use-case by each use case's own integration test,
 * e.g. dsar.integration.test.ts's `auditEvents` assertion against
 * `identity.domain_events` directly). This file is the missing link for
 * `identity` specifically: it spawns the actual worker process (same
 * pattern as auditLogWriter.integration.test.ts, which proves the drain
 * mechanism generically via the `training` schema) and polls the real
 * `admin.audit_log` table after exercising four of the nine identity use
 * cases (registerPerson, grantRole, recordConsent, requestErasure — one
 * from each shape: registration, role, consent, DSAR).
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const WORKER_READY_TIMEOUT_MS = 20_000;
const DRAIN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

async function pollUntil<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

describe("identity use cases -> admin.audit_log (real worker process, end-to-end)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);
  let worker: ChildProcessByStdio<null, Readable, Readable>;
  let workerOutput = "";

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run via `pnpm test:integration`, which wires up " +
          "the disposable testcontainers Postgres via tests/integration/setup.ts.",
      );
    }

    worker = spawn("pnpm", ["--filter", "worker", "start"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.on("data", (chunk) => (workerOutput += chunk.toString()));
    worker.stderr.on("data", (chunk) => (workerOutput += chunk.toString()));

    await pollUntil(async () => {
      if (workerOutput.includes("graphile-worker running")) return true;
      if (worker.exitCode !== null) {
        throw new Error(`worker process exited early (code ${worker.exitCode}):\n${workerOutput}`);
      }
      return undefined;
    }, WORKER_READY_TIMEOUT_MS);
  }, WORKER_READY_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      await new Promise((resolve) => worker.once("exit", resolve));
    }
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.consentRecord.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.dSARRequest.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({
      where: { OR: [{ subjectId: { in: personIds } }, { grantedBy: { in: personIds } }] },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function auditRowFor(resourceId: string, action: string) {
    return pollUntil(async () => {
      const rows = await prisma.auditLog.findMany({ where: { resourceId, action } });
      return rows[0];
    }, DRAIN_TIMEOUT_MS);
  }

  it(
    "registerPerson (person.register) drains into admin.audit_log",
    async () => {
      const session: VerifiedSupabaseSession = {
        supabaseAuthId: newId(),
        email: `${newId().toLowerCase()}@example.com`,
      };
      const result = await registerPerson(prisma, {
        session,
        displayName: "Audit Drain Check",
        primaryChapterId: null,
        dateOfBirth: null,
        ageAttested16Plus: true,
        guardianConsent: null,
        policyVersion: "2026-01-01",
      });
      track(result.personId);

      const row = await auditRowFor(result.personId, "person.register");
      expect(row.actorId).toBe(result.personId);
      expect(row.resourceType).toBe("person");
    },
    DRAIN_TIMEOUT_MS + 5_000,
  );

  it(
    "grantRole (role.grant) drains into admin.audit_log",
    async () => {
      const admin = track((await createPerson(prisma)).id);
      const subject = track((await createPerson(prisma)).id);
      await grantRoleDirect(prisma, { subjectId: admin, role: "org_admin", grantedBy: admin });

      const { roleAssignmentId } = await grantRole(prisma, {
        callerId: admin,
        subjectId: subject,
        role: "mentor",
        scopeType: "global",
        scopeId: null,
      });

      const row = await auditRowFor(roleAssignmentId, "role.grant");
      expect(row.actorId).toBe(admin);
      expect(row.resourceType).toBe("role_assignment");
    },
    DRAIN_TIMEOUT_MS + 5_000,
  );

  it(
    "recordConsent (consent.record) drains into admin.audit_log",
    async () => {
      const person = track((await createPerson(prisma)).id);

      const { consentId } = await recordConsent(prisma, {
        personId: person,
        purpose: "newsletter",
        granted: true,
        policyVersion: "2026-01-01",
        source: "settings_page",
      });

      const row = await auditRowFor(consentId, "consent.record");
      expect(row.actorId).toBe(person);
      expect(row.resourceType).toBe("consent_record");
    },
    DRAIN_TIMEOUT_MS + 5_000,
  );

  it(
    "requestErasure (person.anonymize) drains into admin.audit_log",
    async () => {
      const person = track((await createPerson(prisma)).id);

      await requestErasure(prisma, { personId: person, requestedBy: person });

      const row = await auditRowFor(person, "person.anonymize");
      expect(row.actorId).toBe(person);
      expect(row.resourceType).toBe("person");
    },
    DRAIN_TIMEOUT_MS + 5_000,
  );
});
