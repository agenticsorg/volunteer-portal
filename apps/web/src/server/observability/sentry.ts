/**
 * Sentry wiring for apps/web (ADR-0013 §"Sentry"). This environment has no
 * live Sentry account/DSN — see this repo's Phase 10 honesty constraint —
 * so `errorReporter` genuinely calls `@sentry/nextjs`'s real `captureException`/
 * `captureMessage` when `SENTRY_DSN` is set, and safely no-ops (logs a
 * structured warning, attempts no network call, never throws) when it
 * isn't. `initSentry()` mirrors that: it only calls the real SDK's `init()`
 * when a DSN is configured, so this process never tries to reach a Sentry
 * ingest endpoint that doesn't exist in this environment.
 *
 * `errorReporterForRequest`/`initSentry` are the only two exports other
 * files should use — `sentryClient()` is exported for the global-error
 * boundary, which needs `@sentry/nextjs`'s Next-specific
 * `captureRequestError` (a different function from the generic
 * `MinimalSentryClient.captureException`), not for general use.
 */
import * as Sentry from "@sentry/nextjs";
import { createErrorReporter, type MinimalSentryClient } from "@volunteer-portal/observability";
import { logger } from "./logger";

function isConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

let initialized = false;

/**
 * Called once from `instrumentation.ts`'s `register()`. A no-op (besides a
 * structured log line) when `SENTRY_DSN` is unset — this must never crash
 * app startup in an environment with no Sentry project provisioned.
 */
export function initSentry(): void {
  if (initialized) return;
  initialized = true;
  if (!isConfigured()) {
    logger.warn("observability.sentry_not_configured", {
      context: { reason: "SENTRY_DSN is not set; Sentry.init() skipped." },
    });
    return;
  }
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    // ADR-0013 "Release tracking": every deploy tagged with its git SHA so
    // an error spike can be correlated to a specific deploy. Falls back to
    // "unknown" locally / in this environment where no CI-provided SHA is
    // injected — see .github/workflows for where a real deploy sets this.
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    tracesSampleRate: 0.1,
  });
}

/** The real Sentry client, when configured — `null` otherwise. Matches `MinimalSentryClient`'s shape structurally, no shim needed. */
function sentryClient(): MinimalSentryClient | null {
  return isConfigured() ? (Sentry as unknown as MinimalSentryClient) : null;
}

/** The one `ErrorReporter` apps/web's route handlers / tRPC error formatter should capture through. */
export const errorReporter = createErrorReporter({ sentryClient: sentryClient(), logger });

export { Sentry };
