/**
 * @volunteer-portal/ulid
 *
 * The single ID-generation utility every bounded-context module imports
 * (ADR-0005: Identifier Strategy — ULIDs Everywhere).
 *
 * Every table in every schema (identity, volunteering, training,
 * gamification, community, moderation, notifications, admin) uses a ULID
 * primary key, generated application-side — never via a Postgres default
 * (`gen_random_uuid()`, `nextval()`) and never via a database trigger
 * (ADR-0004, ADR-0005). Every `create()` call must supply its own `id`
 * explicitly via `newId()`; there is no DB-side fallback.
 */
import { ulid } from "ulid";

/**
 * A ULID-shaped identifier. A string typed as `EntityId` is not itself
 * proof that a row with this id exists — see `isValidUlid`.
 */
export type EntityId = string;

/**
 * Generate a new ULID: 26-character, Crockford Base32-encoded,
 * lexicographically sortable by (millisecond) creation time, URL-safe.
 * Monotonic within the current process, guarded by the underlying `ulid`
 * library's internal clock state.
 */
export function newId(): EntityId {
  return ulid();
}

/**
 * Crockford Base32 ULID format, per the ulid spec — the same pattern
 * ADR-0005 specifies for API-boundary (tRPC/REST) input validation, so
 * every module validates incoming ULID-shaped strings identically.
 */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * True if `value` is shaped like a ULID.
 *
 * This is a format check only — it is NOT proof the referenced row
 * exists. The subsequent database lookup still enforces existence and
 * authorization via the `can(subject, action, resource)` policy module
 * (ADR-0007), per ADR-0005's API-boundary validation guidance.
 */
export function isValidUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}
