/**
 * Next.js instrumentation hook (ADR-0013's Implementation Notes
 * `instrumentation.ts` sketch) — lives at `src/instrumentation.ts` per
 * Next's file-convention doc ("place the file in the root of your
 * application or inside a `src` folder if using one";
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`,
 * consulted per `apps/web/AGENTS.md`'s "read the docs before writing any
 * code" warning).
 *
 * `register()` runs once per server runtime instance, before any request is
 * handled — this is where OTel + Sentry get initialized for this process.
 *
 * OTel wiring: ADR-0013's sketch passes `traceExporter: "otlp"` explicitly,
 * but the installed `@vercel/otel` (2.x)'s own default behavior already is
 * exactly what that sketch wants — its `traceExporter` docstring: "an OTLP
 * exporter can be used if configured via environment variables, such as
 * `OTEL_EXPORTER_OTLP_ENDPOINT`" — so this leaves `traceExporter` unset and
 * lets `@vercel/otel` auto-detect. Unset (this environment's actual state:
 * no OTLP collector/Sentry-tracing-ingestion endpoint configured), spans
 * are still recorded against a real registered SDK (so `@opentelemetry/api`
 * calls throughout this app are never no-ops against an absent
 * MeterProvider/TracerProvider) — they're just not exported anywhere,
 * which is the correct, non-crashing behavior for an unconfigured OTLP
 * endpoint.
 *
 * Sentry wiring: delegates to `initSentry()`
 * (`src/server/observability/sentry.ts`), itself gated on `SENTRY_DSN` —
 * see that file's doc comment. `onRequestError` (Next's own hook for
 * server-side render/route/action errors — the "route error handlers" this
 * stage's task asks Sentry to be wired into) routes every caught server
 * error through the same `errorReporter.captureException` every other
 * server-side capture point in this app uses.
 *
 * Runs for both the Node.js and Edge runtimes (`NEXT_RUNTIME` tells us
 * which); Sentry's Next SDK only needs Node-runtime init for this app's
 * purposes (proxy.ts/Edge never captures exceptions itself), so
 * `initSentry()`/`onRequestError`'s real capture is skipped there.
 */
import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "next";

export function register(): void {
  registerOTel({ serviceName: "volunteer-portal" });

  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Dynamic imports: keeps `@sentry/nextjs`/Prisma (Node-oriented) out of
    // the Edge runtime's module graph entirely, rather than merely
    // skipping these calls at runtime.
    void import("./server/observability/sentry").then(({ initSentry }) => initSentry());
    void Promise.all([import("./server/db/prisma"), import("./server/observability/outboxLag")]).then(
      ([{ prisma }, { registerOutboxLagMetrics }]) => registerOutboxLagMetrics(prisma),
    );
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorReporter } = await import("./server/observability/sentry");
  errorReporter.captureException(error, {
    extra: { path: request.path, method: request.method, routeType: context.routeType },
  });
};
