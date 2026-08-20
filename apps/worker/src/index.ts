/**
 * apps/worker — the long-lived graphile-worker process (ADR-0009): "runs
 * as a long-lived Node process (`npx graphile-worker`) separate from the
 * Next.js request-serving process but part of the same deployable
 * codebase/monorepo."
 *
 * Phase 1 (Event Backbone & Platform Audit Log) registers a single task,
 * `audit_log_writer` (ADR-0014 §4). Later phases add this platform's
 * per-schema relay/dispatch tasks and the DSAR/retention jobs on this
 * same runner (ADR-0014's Implementation Notes: `dsar_export_all`,
 * `dsar_erase_subject`, `retention_sweep`, `audit_log_writer`, "All
 * registered in apps/worker/src/jobs/index.ts" — this file is that
 * registration point, named `tasks` here to match graphile-worker's own
 * `TaskList` terminology).
 */
import { run } from "graphile-worker";
import { auditLogWriter } from "./tasks/audit-log-writer.js";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. apps/worker connects to the same Postgres " +
        "instance as apps/web (ADR-0009) — run via `pnpm worker:dev` / " +
        "`pnpm worker:start`, which load it from the repo-root .env.",
    );
  }

  const runner = await run({
    connectionString,
    // graphile-worker provisions its own bookkeeping schema (default
    // "graphile_worker") in this same database — no second stateful
    // system, per ADR-0009's "Postgres is both the system of record and
    // the event-delivery backbone."
    concurrency: 5,
    taskList: {
      audit_log_writer: auditLogWriter,
    },
  });

  // Kick off audit_log_writer's self-rescheduling poll loop on startup;
  // subsequent runs are scheduled by the task itself (see
  // RESCHEDULE_JOB_KEY in tasks/audit-log-writer.ts). jobKeyMode:
  // "replace" makes this safe to run every time the process (re)starts —
  // it won't pile up duplicate pollers alongside one already scheduled.
  await runner.addJob(
    "audit_log_writer",
    {},
    { jobKey: "audit_log_writer_poll", jobKeyMode: "replace" },
  );

  console.log("apps/worker: graphile-worker running (tasks: audit_log_writer)");

  await runner.promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
