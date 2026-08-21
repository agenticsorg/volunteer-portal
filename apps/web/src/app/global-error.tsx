"use client";

/**
 * Next.js App Router's root error boundary (the "global error boundary"
 * this stage's task asks Sentry to be wired into) — file convention:
 * `app/global-error.tsx`, must render its own `<html>`/`<body>` since it
 * replaces the root layout when an error escapes every nested boundary.
 * Always a Client Component (Next's own constraint on this file).
 *
 * Reports to Sentry's *client* SDK when `NEXT_PUBLIC_SENTRY_DSN` is set —
 * a separate, browser-safe env var from the server-side `SENTRY_DSN` this
 * app's `errorReporter` (`src/server/observability/sentry.ts`) uses, since
 * only `NEXT_PUBLIC_*`-prefixed vars are ever inlined into the client
 * bundle. Unset (this environment's actual state — no Sentry project
 * exists to get a DSN from), this intentionally does nothing beyond
 * rendering the fallback UI: no client-side Sentry.init() has been called
 * anywhere in this app, so calling `captureException` without one would be
 * a silent no-op at best; skipping the call entirely is the more honest
 * behavior. Server-side errors (Server Components, Route Handlers, Server
 * Actions) are already captured via `instrumentation.ts`'s `onRequestError`
 * before this boundary ever renders, so production error coverage does not
 * depend on this client-side path.
 */
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    void import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error));
  }, [error]);

  return (
    <html>
      <body>
        <h2>Something went wrong.</h2>
      </body>
    </html>
  );
}
