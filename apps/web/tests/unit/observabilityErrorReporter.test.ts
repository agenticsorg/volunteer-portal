import { describe, expect, it, vi } from "vitest";
import {
  createErrorReporter,
  createLogger,
  runWithRequestContext,
  type MinimalSentryClient,
} from "@volunteer-portal/observability";

// ADR-0013 §"Sentry" adapter contract, unit-tested per this stage's own
// task: (a) unconfigured, calling the capture function does not throw and
// attempts no network call; (b) configured (a fake/mocked Sentry client
// injected), the capture function is actually invoked with the error and
// the current requestId/traceId attached. No real Sentry account/DSN is
// used anywhere in this file — see this repo's Phase 10 honesty
// constraint.
describe("createErrorReporter", () => {
  function silentLogger() {
    return createLogger({ service: "api", sink: () => {} });
  }

  describe("unconfigured (sentryClient: null)", () => {
    it("captureException does not throw and never touches a client", () => {
      const reporter = createErrorReporter({ sentryClient: null, logger: silentLogger() });
      expect(() => reporter.captureException(new Error("boom"))).not.toThrow();
    });

    it("captureMessage does not throw and never touches a client", () => {
      const reporter = createErrorReporter({ sentryClient: null, logger: silentLogger() });
      expect(() => reporter.captureMessage("outbox lag high", "error")).not.toThrow();
    });

    it("logs a structured warning instead of silently doing nothing", () => {
      const lines: string[] = [];
      const logger = createLogger({ service: "api", sink: (line) => lines.push(line) });
      const reporter = createErrorReporter({ sentryClient: null, logger });

      reporter.captureException(new Error("boom"));

      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.level).toBe("warn");
      expect(entry.event).toBe("observability.sentry_not_configured");
    });
  });

  describe("configured (fake sentryClient injected)", () => {
    it("captureException calls straight through to the injected client, with requestId/traceId attached", () => {
      const fakeClient: MinimalSentryClient = {
        captureException: vi.fn().mockReturnValue("event-id-1"),
        captureMessage: vi.fn().mockReturnValue("event-id-2"),
      };
      const reporter = createErrorReporter({ sentryClient: fakeClient, logger: silentLogger() });
      const error = new Error("job blew up");

      runWithRequestContext({ requestId: "req_123", traceId: "trace_abc" }, () => {
        reporter.captureException(error, { extra: { taskName: "audit_log_writer" } });
      });

      expect(fakeClient.captureException).toHaveBeenCalledTimes(1);
      const [capturedError, hint] = (fakeClient.captureException as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(capturedError).toBe(error);
      expect(hint.extra).toMatchObject({ requestId: "req_123", traceId: "trace_abc", taskName: "audit_log_writer" });
    });

    it("captureMessage calls straight through to the injected client with the given level", () => {
      const fakeClient: MinimalSentryClient = {
        captureException: vi.fn(),
        captureMessage: vi.fn().mockReturnValue("event-id"),
      };
      const reporter = createErrorReporter({ sentryClient: fakeClient, logger: silentLogger() });

      reporter.captureMessage("Outbox drain lag exceeded 10min for community", "error");

      expect(fakeClient.captureMessage).toHaveBeenCalledWith("Outbox drain lag exceeded 10min for community", "error");
    });

    it("a throwing client does not propagate — capture failures never crash the caller", () => {
      const fakeClient: MinimalSentryClient = {
        captureException: vi.fn().mockImplementation(() => {
          throw new Error("Sentry SDK internal failure");
        }),
        captureMessage: vi.fn(),
      };
      const reporter = createErrorReporter({ sentryClient: fakeClient, logger: silentLogger() });

      expect(() => reporter.captureException(new Error("original error"))).not.toThrow();
    });
  });
});
