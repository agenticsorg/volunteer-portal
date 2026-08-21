/**
 * Sentry-agnostic error-reporter adapter (ADR-0013 §"Sentry"). Same
 * external-service-adapter boundary shape as every other module's
 * `infra/*Client.ts` (`training`'s `cloudflareStreamClient.ts`,
 * `notifications`'s `resendClient.ts`) — but a deliberately different
 * failure mode: those throw `ExternalServiceNotConfiguredError` when their
 * env var is missing, because *not sending* an email/upload the caller
 * explicitly asked for must be visible. Error capture is the opposite case
 * — it is inherently best-effort telemetry sitting alongside real request/
 * job work, so failing to *report* an error must never itself crash the
 * app or the job that error already broke. Unconfigured (`SENTRY_DSN`
 * unset), `captureException`/`captureMessage` log a structured warning via
 * this codebase's own logger and return without attempting any network
 * call; configured, they call straight through to the injected Sentry
 * client's own capture functions.
 *
 * Framework-agnostic on purpose: this file has no dependency on
 * `@sentry/nextjs` or `@sentry/node` — apps/web wires this factory with a
 * `@sentry/nextjs`-backed client (see
 * `apps/web/src/server/observability/sentry.ts`), apps/worker wires it with
 * a `@sentry/node`-backed client (see
 * `apps/worker/src/observability/sentry.ts`); both real Sentry SDKs already
 * export functions matching `MinimalSentryClient`'s shape, so no adapter
 * shim is needed on that side either. Tests inject a fake client that
 * matches the same shape (see errorReporter.test.ts), needing no real
 * Sentry account or network access.
 */
import type { Logger } from "./logEnvelope";
import { getRequestId, getTraceId } from "./requestContext";

/** The exact slice of the real `@sentry/*` SDK surface this adapter calls. Both `@sentry/nextjs` and `@sentry/node` satisfy this structurally — no shim needed. */
export interface MinimalSentryClient {
  captureException(exception: unknown, hint?: { extra?: Record<string, unknown> }): string;
  captureMessage(message: string, level?: "warning" | "error"): string;
}

export interface ErrorReporterContext {
  /** Extra structured fields attached to the Sentry event alongside requestId/traceId — e.g. `{ jobName: "audit_log_writer" }`. */
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  /** Captures a thrown error. No-ops (logs a warning, returns) when Sentry isn't configured; never throws either way. */
  captureException(error: unknown, context?: ErrorReporterContext): void;
  /**
   * Captures a message-only event (e.g. ADR-0013's outbox-lag-exceeded
   * alert) at the given severity. Same no-op/never-throw contract. Matches
   * ADR-0013's Implementation Notes sketch (`Sentry.captureMessage(msg,
   * "error")`) exactly — no `extra` payload, so any correlation context
   * belongs in `message` itself (e.g. include the schema name in the text).
   */
  captureMessage(message: string, level: "warning" | "error"): void;
}

function currentCorrelationExtra(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: getRequestId(),
    traceId: getTraceId(),
    ...extra,
  };
}

/**
 * `sentryClient` is `null` when `SENTRY_DSN` is unset (the caller decides
 * that — see the two `server/observability/sentry.ts` wiring files) so this
 * module never reads `process.env` itself, keeping it trivially testable.
 */
export function createErrorReporter(deps: { sentryClient: MinimalSentryClient | null; logger: Logger }): ErrorReporter {
  return {
    captureException(error, context) {
      if (!deps.sentryClient) {
        deps.logger.warn("observability.sentry_not_configured", {
          context: {
            reason: "SENTRY_DSN is not set; error capture skipped (no network call attempted).",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      try {
        deps.sentryClient.captureException(error, { extra: currentCorrelationExtra(context?.extra) });
      } catch (reportingError) {
        // Reporting itself must never crash the app/job it's reporting about.
        deps.logger.warn("observability.sentry_capture_failed", {
          context: { reportingError: reportingError instanceof Error ? reportingError.message : String(reportingError) },
        });
      }
    },
    captureMessage(message, level) {
      if (!deps.sentryClient) {
        deps.logger.warn("observability.sentry_not_configured", {
          context: { reason: "SENTRY_DSN is not set; captureMessage skipped (no network call attempted).", message },
        });
        return;
      }
      try {
        deps.sentryClient.captureMessage(message, level);
      } catch (reportingError) {
        deps.logger.warn("observability.sentry_capture_failed", {
          context: { reportingError: reportingError instanceof Error ? reportingError.message : String(reportingError) },
        });
      }
    },
  };
}
