import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobHelpers, Task } from "graphile-worker";
import { getRequestId } from "@volunteer-portal/observability";
import { withJobErrorCapture, extractRequestId } from "../../src/observability/withJobErrorCapture";

function fakeHelpers(overrides: Partial<JobHelpers["job"]> = {}): JobHelpers {
  return {
    job: { id: "job_1", attempts: 1, ...overrides },
  } as unknown as JobHelpers;
}

describe("extractRequestId", () => {
  it("reads _meta.requestId when present (a job payload that is a domain event's own stamped payload)", () => {
    expect(extractRequestId({ hourEntryId: "he_1", _meta: { requestId: "req_from_event" } })).toBe("req_from_event");
  });

  it("returns undefined for payload shapes with no _meta (e.g. audit_log_writer's {} self-reschedule payload)", () => {
    expect(extractRequestId({})).toBeUndefined();
    expect(extractRequestId(null)).toBeUndefined();
    expect(extractRequestId("not an object")).toBeUndefined();
    expect(extractRequestId({ _meta: "not an object either" })).toBeUndefined();
    expect(extractRequestId({ _meta: { requestId: 123 } })).toBeUndefined();
  });
});

describe("withJobErrorCapture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the task with a requestId bound in the request context, extracted from the payload", async () => {
    let seenDuringRun: string | undefined;
    const task: Task = async (payload) => {
      seenDuringRun = getRequestId();
      expect(payload).toEqual({ _meta: { requestId: "req_abc" } });
    };

    await withJobErrorCapture("toy_task", task)({ _meta: { requestId: "req_abc" } }, fakeHelpers());

    expect(seenDuringRun).toBe("req_abc");
  });

  it("generates a fresh requestId when the payload carries none", async () => {
    let seenDuringRun: string | undefined;
    const task: Task = async () => {
      seenDuringRun = getRequestId();
    };

    await withJobErrorCapture("audit_log_writer", task)({}, fakeHelpers());

    expect(seenDuringRun).toBeTruthy();
  });

  it("re-throws the task's error after reporting it — graphile-worker's own retry behavior must be unaffected", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const boom = new Error("task blew up");
    const task: Task = async () => {
      throw boom;
    };

    await expect(withJobErrorCapture("toy_task", task)({}, fakeHelpers({ id: "job_42", attempts: 2 }))).rejects.toBe(
      boom,
    );

    // A structured "worker.job_failed" log line was written (stdout, this
    // process's own logger — see observability/logger.ts) naming the task
    // and job id, alongside Sentry's own (safely no-op'd, unconfigured in
    // this test env — see observability/errorReporter.test.ts in
    // packages/observability for that behavior's own dedicated coverage)
    // "sentry_not_configured" warning line.
    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    const failedLine = lines.find((line) => line.includes("worker.job_failed"));
    expect(failedLine).toBeDefined();
    const parsed = JSON.parse(failedLine!);
    expect(parsed).toMatchObject({ event: "worker.job_failed", context: { taskName: "toy_task", jobId: "job_42", attempts: 2 } });
  });

  it("does not swallow a successful task's return value path (resolves cleanly on success)", async () => {
    const task: Task = async () => {
      /* no-op success */
    };
    await expect(withJobErrorCapture("toy_task", task)({}, fakeHelpers())).resolves.toBeUndefined();
  });
});
