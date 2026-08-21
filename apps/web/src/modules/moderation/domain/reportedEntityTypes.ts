/**
 * The polymorphic `reportedEntityType` closed set (docs/ddd/
 * moderation-trust-safety.md's Report aggregate; API Contract Sketch's
 * `fileReport` Zod enum) — the anti-corruption vocabulary this context
 * uses to point at an entity it never joins into directly (this file's own
 * "Reported Entity" term). Kept here, not inline in `fileReport.ts`, so a
 * later API-layer stage's Zod schema and this domain/application layer
 * share exactly one source of truth for the set, same "one closed set,
 * one place" precedent as `community`'s `INBOUND_EVENT_TYPES`.
 */
export const REPORTED_ENTITY_TYPES = [
  "community.post",
  "community.kudos",
  "identity.person",
  "community.team",
  "community.mentorship",
] as const;

export type ReportedEntityType = (typeof REPORTED_ENTITY_TYPES)[number];

export function isReportedEntityType(value: string): value is ReportedEntityType {
  return (REPORTED_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * The closed `reason` set (docs/ddd/moderation-trust-safety.md's Report
 * aggregate: "app-layer-enforced per ADR-0014's convention of app-layer
 * enums over DB enums for evolvability").
 */
export const REPORT_REASONS = [
  "harassment",
  "spam",
  "hate_speech",
  "misinformation",
  "safety_concern",
  "impersonation",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
