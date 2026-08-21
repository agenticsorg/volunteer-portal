/**
 * Next.js client-side instrumentation hook — file convention:
 * `instrumentation-client.ts`, root of the app or inside `src`
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md`,
 * consulted per `apps/web/AGENTS.md`'s "read the docs before writing any
 * code" warning). Runs once, browser-side, after the HTML document loads
 * and before React hydration begins.
 *
 * This is the client half of ADR-0013's "Sentry: exception/error capture
 * across Next.js (client + server)" — the server half is
 * `src/instrumentation.ts` + `src/server/observability/sentry.ts`.
 *
 * Gated on `NEXT_PUBLIC_SENTRY_DSN` (a separate, browser-safe env var from
 * the server-only `SENTRY_DSN` — only `NEXT_PUBLIC_*`-prefixed vars are
 * ever inlined into the client bundle). Unset (this environment's actual
 * state — no Sentry project exists to get a DSN from), `Sentry.init()` is
 * skipped entirely: no client-side error capture happens, and
 * `app/global-error.tsx`'s `captureException` call (gated on the same env
 * var) correctly never fires either. Set it, and this init is what makes
 * that `captureException` call a real report instead of a no-op.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    // Mirrors server-side release tagging (`server/observability/sentry.ts`)
    // so client and server errors correlate to the same deploy. Falls back
    // to "unknown" locally / in this environment where no CI-provided SHA
    // is injected into the client bundle.
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? "unknown",
    tracesSampleRate: 0.1,
  });
}
