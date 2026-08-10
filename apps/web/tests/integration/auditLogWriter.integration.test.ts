import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";

// Real end-to-end verification of the Phase 1 event backbone: this test
// does NOT call apps/worker's drain logic in-process or re-implement its
// SQL — it spawns the actual `apps/worker` graphile-worker process (the
// same one `pnpm worker:start` runs in production/dev), writes a real
// audit-tagged domain_events row via the real recordAuditEvent() producer,
// and waits for the real 5s poll loop to drain it into admin.audit_log.
//
// This is the missing link the existing unit/integration coverage does
// not exercise: recordAuditEvent.integration.test.ts proves the producer
// side writes a row audit_log_writer's WHERE clause *would* match, but
// nothing before this test ever actually ran audit_log_writer itself
// against a real admin.audit_log table.
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const WORKER_READY_TIMEOUT_MS = 20_000;
const DRAIN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

describe("audit_log_writer (real worker process, end-to-end)", () => {
  const prisma = new PrismaClient();
  let worker: ChildProcessByStdio<null, Readable, Readable>;
  let workerOutput = "";

  async function pollUntil<T>(
    fn: () => Promise<T | undefined>,
    timeoutMs: number,
  ): Promise<T> {
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

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run via `pnpm test:integration` (loads .env) not `vitest` directly.",
      );
    }

    worker = spawn("pnpm", ["--filter", "worker", "start"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.on("data", (chunk) => {
      workerOutput += chunk.toString();
    });
    worker.stderr.on("data", (chunk) => {
      workerOutput += chunk.toString();
    });

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
    await prisma.$disconnect();
  });

  it(
    "drains a real recordAuditEvent() write into admin.audit_log with the correct shape",
    async () => {
      const resourceId = `e2e-hour-${newId()}`;

      await prisma.$transaction(async (tx) => {
        await recordAuditEvent(tx.trainingDomainEvent, {
          actorId: "actor-e2e",
          actorType: "user",
          action: "hour.approved",
          resourceType: "hour_entry",
          resourceId,
          scopeType: "chapter",
          scopeId: "chapter-e2e",
          beforeState: { status: "pending" },
          afterState: { status: "approved" },
          metadata: { source: "auditLogWriter.integration.test" },
        });
      });

      // Find the event id the producer generated, so we know exactly which
      // admin.audit_log row (same id, by contract) to wait for.
      const [sourceEvent] = await prisma.trainingDomainEvent.findMany({
        where: { aggregateId: resourceId },
      });
      expect(sourceEvent).toBeDefined();

      const auditRow = await pollUntil(async () => {
        const rows = await prisma.auditLog.findMany({ where: { id: sourceEvent.id } });
        return rows[0];
      }, DRAIN_TIMEOUT_MS);

      expect(auditRow.actorId).toBe("actor-e2e");
      expect(auditRow.actorType).toBe("user");
      expect(auditRow.action).toBe("hour.approved");
      expect(auditRow.resourceType).toBe("hour_entry");
      expect(auditRow.resourceId).toBe(resourceId);
      expect(auditRow.scopeType).toBe("chapter");
      expect(auditRow.scopeId).toBe("chapter-e2e");
      expect(auditRow.beforeState).toEqual({ status: "pending" });
      expect(auditRow.afterState).toEqual({ status: "approved" });
      expect(auditRow.metadata).toEqual({ source: "auditLogWriter.integration.test" });

      // The source row must be marked processed by the real worker, not
      // left for a later poll.
      const drainedSource = await prisma.trainingDomainEvent.findUnique({
        where: { id: sourceEvent.id },
      });
      expect(drainedSource?.processedAt).not.toBeNull();

      await prisma.trainingDomainEvent.deleteMany({ where: { aggregateId: resourceId } });
    },
    DRAIN_TIMEOUT_MS + 5_000,
  );

  it(
    "leaves a non-audit-tagged domain event alone (does not write it to admin.audit_log)",
    async () => {
      const id = newId();
      const aggregateId = `e2e-nonaudit-${id}`;

      await prisma.trainingDomainEvent.create({
        data: {
          id,
          aggregateType: "hour_entry",
          aggregateId,
          eventType: "hour.viewed",
          payload: { audit: false, note: "not an audit event" },
        },
      });

      // Give the worker at least one more poll cycle to (not) pick this up.
      await new Promise((r) => setTimeout(r, 6_000));

      const auditRows = await prisma.auditLog.findMany({ where: { id } });
      expect(auditRows).toHaveLength(0);

      await prisma.trainingDomainEvent.deleteMany({ where: { aggregateId } });
    },
    15_000,
  );
});
