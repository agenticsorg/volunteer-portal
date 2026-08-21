/**
 * The one structured-logging instance apps/worker imports (ADR-0013
 * §"Structured JSON logging") — every log line this process writes carries
 * `service: "graphile-worker"`. Same split as `apps/web/src/server/
 * observability/logger.ts` supplying `"api"` — both wrap
 * `@volunteer-portal/observability`'s shared `createLogger`.
 */
import { createLogger } from "@volunteer-portal/observability";

export const logger = createLogger({ service: "graphile-worker" });
