import { describe, expect, it } from "vitest";
import {
  buildLogEnvelope,
  createLogger,
  redact,
  runWithRequestContext,
} from "@volunteer-portal/observability";

// ADR-0013's structured-log envelope (Implementation Notes) and its
// redaction layer — the one place every log line in this codebase is
// assembled (`packages/observability/src/logEnvelope.ts`).
describe("logEnvelope", () => {
  describe("redact", () => {
    it("never lets a field whose key matches /SECRET|TOKEN|KEY|PASSWORD/i reach the output", () => {
      const input = {
        apiKey: "sk_live_abc123",
        resendApiKey: "re_abc123",
        RESEND_WEBHOOK_SECRET: "whsec_abc",
        password: "hunter2",
        accessToken: "tok_abc",
        userId: "person_1", // does NOT match — must survive untouched
        event: "did.something",
      };

      const result = redact(input) as Record<string, unknown>;

      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.resendApiKey).toBe("[REDACTED]");
      expect(result.RESEND_WEBHOOK_SECRET).toBe("[REDACTED]");
      expect(result.password).toBe("[REDACTED]");
      expect(result.accessToken).toBe("[REDACTED]");
      expect(result.userId).toBe("person_1");
      expect(result.event).toBe("did.something");

      // The raw secret values must not appear anywhere in the serialized output.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("sk_live_abc123");
      expect(serialized).not.toContain("re_abc123");
      expect(serialized).not.toContain("whsec_abc");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("tok_abc");
    });

    it("redacts nested objects and objects inside arrays, at any depth", () => {
      const input = {
        context: {
          request: { headers: { apiToken: "Bearer secret-token" } },
          items: [{ apiKey: "nested-secret" }, { safe: "value" }],
        },
      };

      const result = redact(input);

      expect(result.context.request.headers.apiToken).toBe("[REDACTED]");
      expect((result.context.items[0] as Record<string, unknown>).apiKey).toBe("[REDACTED]");
      expect((result.context.items[1] as Record<string, unknown>).safe).toBe("value");
    });

    it("leaves non-plain-object values (arrays, primitives, Dates) unchanged", () => {
      expect(redact("plain string")).toBe("plain string");
      expect(redact(42)).toBe(42);
      expect(redact(null)).toBe(null);
      expect(redact(["a", "b"])).toEqual(["a", "b"]);
      const date = new Date("2026-01-01T00:00:00.000Z");
      expect(redact(date)).toBe(date);
    });
  });

  describe("buildLogEnvelope", () => {
    it("builds the fixed ADR-0013 envelope shape", () => {
      const envelope = buildLogEnvelope("info", "api", "hour_entry.approved", {
        subjectId: "person_1",
        context: { hourEntryId: "he_1" },
      });

      expect(envelope.level).toBe("info");
      expect(envelope.service).toBe("api");
      expect(envelope.event).toBe("hour_entry.approved");
      expect(envelope.subjectId).toBe("person_1");
      expect(envelope.context).toEqual({ hourEntryId: "he_1" });
      expect(() => new Date(envelope.timestamp).toISOString()).not.toThrow();
      expect(envelope.timestamp).toBe(new Date(envelope.timestamp).toISOString());
    });

    it("redacts context fields automatically", () => {
      const envelope = buildLogEnvelope("warn", "api", "notification.send_failed", {
        context: { resendApiKey: "re_live_secret" },
      });
      expect(JSON.stringify(envelope)).not.toContain("re_live_secret");
      expect((envelope.context as Record<string, unknown>).resendApiKey).toBe("[REDACTED]");
    });

    it("picks up requestId/traceId ambiently from the current request context when not passed explicitly", () => {
      const envelope = runWithRequestContext({ requestId: "req_ambient", traceId: "trace_ambient" }, () =>
        buildLogEnvelope("info", "api", "some.event"),
      );
      expect(envelope.requestId).toBe("req_ambient");
      expect(envelope.traceId).toBe("trace_ambient");
    });

    it("has no requestId/traceId outside any request context scope", () => {
      const envelope = buildLogEnvelope("info", "api", "some.event");
      expect(envelope.requestId).toBeUndefined();
      expect(envelope.traceId).toBeUndefined();
    });

    it("prefers an explicitly passed requestId over the ambient one", () => {
      const envelope = runWithRequestContext({ requestId: "req_ambient" }, () =>
        buildLogEnvelope("info", "api", "some.event", { requestId: "req_explicit" }),
      );
      expect(envelope.requestId).toBe("req_explicit");
    });
  });

  describe("createLogger", () => {
    it("writes one JSON line per call through the injected sink, matching the envelope shape", () => {
      const lines: string[] = [];
      const logger = createLogger({ service: "graphile-worker", sink: (line) => lines.push(line) });

      logger.info("worker.started", { context: { tasks: ["audit_log_writer"] } });
      logger.error("worker.job_failed", { context: { apiKey: "should-be-redacted" } });

      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first).toMatchObject({ level: "info", service: "graphile-worker", event: "worker.started" });
      const second = JSON.parse(lines[1]);
      expect(second.level).toBe("error");
      expect(second.context.apiKey).toBe("[REDACTED]");
      expect(lines[1]).not.toContain("should-be-redacted");
    });
  });
});
