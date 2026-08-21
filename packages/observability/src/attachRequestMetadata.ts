/**
 * Stamps the current request's `requestId` (ADR-0013 §"Correlation") onto a
 * domain-event payload before it's written to a `<schema>.domain_events`
 * outbox row, under a reserved `_meta` key — so a graphile-worker job later
 * draining that event can log the originating `requestId` and a production
 * incident can be traced from the original HTTP request through to the
 * async job that serviced it.
 *
 * Deliberately payload-shape-preserving: every bounded-context module's own
 * `publish*Event` helper (`community`/`gamification`/`moderation`/
 * `notifications`) calls this on the way in, so no call site upstream of
 * those helpers needs to know `_meta` exists. `_meta` is additive — nothing
 * that already reads a specific payload field is affected, and a consumer
 * that ignores unknown keys (the norm for this codebase's payload
 * consumers) sees no difference at all when no `requestId` is current.
 */
export interface RequestEventMetadata {
  requestId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.constructor === Object;
}

/**
 * Returns `payload` unchanged when there's no current `requestId` (e.g. a
 * script or test invoking a publish helper outside any
 * `runWithRequestContext` scope) or when `payload` isn't a plain object
 * (every real payload in this codebase is one, but this stays a no-op
 * rather than throwing if that's ever not true). Otherwise returns a new
 * object with `_meta.requestId` merged in, never mutating the input.
 */
export function attachRequestMetadata<T>(payload: T, requestId: string | undefined): T {
  if (requestId === undefined || !isPlainObject(payload)) {
    return payload;
  }
  return { ...payload, _meta: { requestId } satisfies RequestEventMetadata } as T;
}
