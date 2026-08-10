/**
 * The eight bounded-context Postgres schemas (docs/ddd/00-context-map.md,
 * ADR-0001), each of which owns its own `domain_events` outbox table
 * (ADR-0009). Kept as one explicit whitelist, imported everywhere a task
 * needs to iterate "every schema's outbox" — never derived from
 * information_schema at runtime and never from any external input, so
 * schema-qualified identifiers built from this list are safe to
 * interpolate directly into SQL (see `audit-log-writer.ts`).
 */
export const BOUNDED_CONTEXT_SCHEMAS = [
  "identity",
  "volunteering",
  "training",
  "gamification",
  "community",
  "moderation",
  "notifications",
  "admin",
] as const;

export type BoundedContextSchema = (typeof BOUNDED_CONTEXT_SCHEMAS)[number];
