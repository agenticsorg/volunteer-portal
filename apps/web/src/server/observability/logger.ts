/**
 * The one structured-logging instance apps/web's server-side code imports
 * (ADR-0013 §"Structured JSON logging") — every log line this process
 * writes carries `service: "api"`. Built on `@volunteer-portal/observability`'s
 * `createLogger` (the shared envelope-building + redaction logic); this
 * file only supplies the app-specific `service` name, same split as
 * `apps/worker/src/observability/logger.ts` supplying `"graphile-worker"`.
 */
import { createLogger } from "@volunteer-portal/observability";

export const logger = createLogger({ service: "api" });
