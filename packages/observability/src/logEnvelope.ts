/**
 * Structured JSON logging (ADR-0013 §"Structured JSON logging": "every log
 * line is JSON with a fixed envelope (`timestamp`, `level`, `service`,
 * `traceId`, `userId`/`subjectId` when applicable, `event`, plus context
 * fields) — never free-text `console.log`"). This module is the *only*
 * place a log line is assembled and serialized; `createLogger()` is what
 * apps/web's and apps/worker's own `server/observability/logger.ts` /
 * `observability/logger.ts` wrap into the one instance the rest of that
 * app's code imports.
 */
import { getRequestId, getTraceId } from "./requestContext";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** ADR-0013's Implementation Notes envelope, verbatim. */
export interface LogEnvelope {
  timestamp: string; // ISO 8601
  level: LogLevel;
  service: string; // 'api' | 'graphile-worker' | 'webhook-receiver'
  traceId?: string;
  requestId?: string;
  subjectId?: string;
  event: string; // e.g. 'hour_entry.approved', 'video.webhook_received'
  context?: Record<string, unknown>;
}

/**
 * Extra fields a call site may pass alongside `event` — `subjectId`/
 * `traceId`/`requestId` are optional overrides; when omitted they're filled
 * in from the current `requestContext` (see requestContext.ts) so ordinary
 * call sites never need to thread them through by hand.
 */
export interface LogCallOptions {
  subjectId?: string;
  requestId?: string;
  traceId?: string;
  context?: Record<string, unknown>;
}

/**
 * Redacts any object key matching /SECRET|TOKEN|KEY|PASSWORD/i, anywhere in
 * a (JSON-serializable) value, recursively — so a context field named e.g.
 * `apiKey`, `resendApiKey`, `SENTRY_AUTH_TOKEN`, or `password` never reaches
 * stdout, regardless of nesting depth or whether the field was added by a
 * call site that forgot this rule exists. Matches on the *key name only*
 * (not the value), matching ADR-0013's Negative-consequences note that
 * logging discipline must be structurally enforced, not left to review.
 *
 * Non-plain-object/array values pass through unchanged (there is no key to
 * check). Arrays are walked element-wise. `Date`/other non-plain objects
 * are treated as opaque values (not walked as key/value maps) so they
 * serialize the same way `JSON.stringify` would treat them elsewhere.
 */
const SECRET_KEY_PATTERN = /SECRET|TOKEN|KEY|PASSWORD/i;
const REDACTED_PLACEHOLDER = "[REDACTED]";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.constructor === Object;
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : redact(fieldValue);
  }
  return result as T;
}

/** Where a serialized log line is written. Defaults to `process.stdout`; injectable so tests never touch real stdout. */
export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  process.stdout.write(line + "\n");
};

/** Builds one `LogEnvelope` (redacted, timestamped) without writing it anywhere — the pure, directly-testable core. */
export function buildLogEnvelope(level: LogLevel, service: string, event: string, options: LogCallOptions = {}): LogEnvelope {
  const ambient = options.requestId !== undefined || options.traceId !== undefined
    ? undefined
    : { requestId: getRequestId(), traceId: getTraceId() };

  const envelope: LogEnvelope = {
    timestamp: new Date().toISOString(),
    level,
    service,
    event,
  };
  const requestId = options.requestId ?? ambient?.requestId;
  const traceId = options.traceId ?? ambient?.traceId;
  if (requestId !== undefined) envelope.requestId = requestId;
  if (traceId !== undefined) envelope.traceId = traceId;
  if (options.subjectId !== undefined) envelope.subjectId = options.subjectId;
  if (options.context !== undefined) envelope.context = redact(options.context);
  return envelope;
}

export interface Logger {
  debug(event: string, options?: LogCallOptions): void;
  info(event: string, options?: LogCallOptions): void;
  warn(event: string, options?: LogCallOptions): void;
  error(event: string, options?: LogCallOptions): void;
}

/**
 * Builds the one `Logger` instance a service uses for every log line.
 * `service` is the fixed `LogEnvelope.service` value for every call made
 * through the returned logger (`"api"`, `"graphile-worker"`,
 * `"webhook-receiver"` per ADR-0013). `sink` defaults to `process.stdout`.
 */
export function createLogger(config: { service: string; sink?: LogSink }): Logger {
  const sink = config.sink ?? defaultSink;
  const write = (level: LogLevel, event: string, options?: LogCallOptions) => {
    sink(JSON.stringify(buildLogEnvelope(level, config.service, event, options)));
  };
  return {
    debug: (event, options) => write("debug", event, options),
    info: (event, options) => write("info", event, options),
    warn: (event, options) => write("warn", event, options),
    error: (event, options) => write("error", event, options),
  };
}
