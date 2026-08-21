/**
 * The central graphile-worker job-execution wrapper this stage's task asks
 * for ("if apps/worker doesn't already have a central job-execution
 * wrapper, add one") — apps/worker didn't have one (its single registered
 * task, `audit_log_writer`, ran unwrapped). Every task registered in
 * `index.ts`'s `taskList` should be wrapped with this before being handed
 * to graphile-worker, so:
 *
 *   1. a `requestId` (ADR-0013 §"Correlation") is bound for the duration of
 *      the job run — either the originating HTTP request's id, when the
 *      job is draining a domain event whose payload carries
 *      `_meta.requestId` (see `@volunteer-portal/observability`'s
 *      `attachRequestMetadata`), or a fresh one generated for this job run
 *      when there's no single originating request (e.g. `audit_log_writer`
 *      drains many schemas/events in one run);
 *   2. every uncaught exception is captured through the same
 *      `errorReporter.captureException` apps/web's error paths use, tagged
 *      with the task name, before being re-thrown so graphile-worker's own
 *      retry/backoff behavior is unaffected.
 */
import type { Task, JobHelpers } from "graphile-worker";
import { runWithRequestContext, generateRequestId } from "@volunteer-portal/observability";
import { errorReporter } from "./sentry";
import { logger } from "./logger";

/**
 * Wraps `task` so it runs inside a request-context scope and reports any
 * uncaught exception to Sentry (a safe no-op when `SENTRY_DSN` is unset —
 * see `sentry.ts`) before re-throwing, letting graphile-worker's normal
 * failure/retry handling proceed exactly as it would unwrapped.
 */
export function withJobErrorCapture(taskName: string, task: Task): Task {
  return async (payload, helpers: JobHelpers) => {
    const requestId = extractRequestId(payload) ?? generateRequestId();
    await runWithRequestContext({ requestId }, async () => {
      try {
        await task(payload, helpers);
      } catch (error) {
        errorReporter.captureException(error, { extra: { taskName, jobId: helpers.job.id } });
        logger.error("worker.job_failed", {
          requestId,
          context: { taskName, jobId: helpers.job.id, attempts: helpers.job.attempts },
        });
        throw error;
      }
    });
  };
}

/**
 * A job that processes one domain event (a future per-schema dispatch
 * task — `audit_log_writer`'s SQL-only drain doesn't do this yet) would be
 * enqueued with that event's own `payload` as the job payload, e.g.
 * `helpers.addJob("send_notification", event.payload)` — since
 * `publish*Event` helpers already stamp `payload._meta.requestId` onto
 * every domain event (`attachRequestMetadata`, `@volunteer-portal/observability`),
 * that same `_meta.requestId` shows up directly on the job payload this
 * function receives. Best-effort extraction: `undefined` for any payload
 * shape that doesn't match (e.g. `audit_log_writer`'s `{}` self-reschedule
 * payload), which just means this job run gets its own fresh id instead of
 * inheriting one.
 */
export function extractRequestId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const meta = (payload as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const requestId = (meta as { requestId?: unknown }).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}
