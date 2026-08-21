/**
 * Request/trace-id correlation context (ADR-0013 §"Correlation": "every
 * inbound request gets a `requestId` (propagated as `traceId` into OTel
 * spans); every domain event and background job carries the originating
 * `requestId` through the outbox").
 *
 * Backed by Node's `AsyncLocalStorage` so the id set once, at the top of a
 * request (a tRPC procedure call) or a background job (a graphile-worker
 * task), is transparently readable by every function invoked anywhere
 * inside that same async call tree — the structured logger, the four
 * bounded-context `publish*Event` helpers, an error-reporter capture call —
 * without threading a `requestId` parameter through every intermediate
 * function signature. This is the same mechanism Node's own diagnostics
 * channel / OTel SDKs use for context propagation.
 *
 * Node-only (`node:async_hooks`): fine for apps/web's actual request-serving
 * Route Handlers (Prisma itself requires the Node.js runtime, not Edge, so
 * `/api/trpc/[trpc]/route.ts` already runs there) and for apps/worker's
 * long-lived Node process. `proxy.ts` (Next Middleware, Edge runtime) only
 * *generates* the id via Web Crypto's `crypto.randomUUID()` — it never
 * imports this module.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContextValue {
  /** Correlates one inbound HTTP request (or one background job run) across logs, Sentry, and OTel. */
  requestId: string;
  /**
   * The OTel trace id this request/job executed under, when a trace is
   * active (`instrumentation.ts` registers a real OTel SDK only when
   * `OTEL_EXPORTER_OTLP_ENDPOINT` is set — see that file). `undefined`
   * outside an active span, which is the common case in this environment
   * (no OTLP backend configured) and must never throw or break logging.
   */
  traceId?: string;
}

const storage = new AsyncLocalStorage<RequestContextValue>();

/** A fresh, globally-unique request id — `crypto.randomUUID()`, available in both Node and Edge runtimes. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Runs `fn` with `value` bound as the current request context. Every
 * `getRequestId()`/`getTraceId()` call made synchronously or from any
 * Promise/callback chain started inside `fn` sees this same `value`.
 */
export function runWithRequestContext<T>(value: RequestContextValue, fn: () => T): T {
  return storage.run(value, fn);
}

/** The current request's id, or `undefined` outside any `runWithRequestContext` scope (e.g. process startup). */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The current request's OTel trace id, or `undefined` when no trace is active. */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/** The full current context, or `undefined` outside any scope — for callers that want both ids in one read. */
export function getRequestContext(): RequestContextValue | undefined {
  return storage.getStore();
}
