/**
 * Sentry wiring for apps/worker (ADR-0013 §"Sentry": "exception/error
 * capture across ... graphile-worker jobs"). Same env-gated,
 * never-throws-when-unconfigured contract as apps/web's
 * `server/observability/sentry.ts` — see that file's doc comment for the
 * full rationale (this environment has no live Sentry DSN configured).
 * `@sentry/node` here rather than `@sentry/nextjs`: this process is a
 * plain long-lived Node script, not a Next.js app.
 */
import * as Sentry from "@sentry/node";
import { createErrorReporter, type MinimalSentryClient } from "@volunteer-portal/observability";
import { logger } from "./logger";

function isConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

let initialized = false;

/** Called once from `index.ts`'s `main()`, before the graphile-worker runner starts. */
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
    // ADR-0013 "Release tracking" — see apps/web's matching sentry.ts comment.
    release: process.env.SENTRY_RELEASE ?? "unknown",
    tracesSampleRate: 0.1,
  });
}

function sentryClient(): MinimalSentryClient | null {
  return isConfigured() ? (Sentry as unknown as MinimalSentryClient) : null;
}

/** The one `ErrorReporter` every job wrapper (`withJobErrorCapture.ts`) captures through. */
export const errorReporter = createErrorReporter({ sentryClient: sentryClient(), logger });
