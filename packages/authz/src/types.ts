/**
 * @volunteer-portal/authz — shared types (ADR-0007).
 *
 * `identity.role_assignments`' scope hierarchy (`global > chapter > team`)
 * and role catalog, mirrored here exactly (`identity.role_name` /
 * `identity.scope_type` in apps/web/prisma/schema.prisma) — this package
 * has no `@prisma/client` dependency (ADR-0007's Implementation Notes:
 * "`authz` has zero dependencies on domain modules beyond the shared
 * `Person` type"), so every shape below is a plain, structural TypeScript
 * type a caller's own Prisma rows already satisfy without any mapping step.
 */

export type Role =
  | "volunteer"
  | "mentor"
  | "chapter_lead"
  | "content_admin"
  | "org_admin"
  | "moderator";

export type ScopeType = "global" | "chapter" | "team";

/**
 * Mirrors `identity.persons.status` (`apps/web/prisma/schema.prisma`).
 * `can()` fails closed on anything but `"active"` — see `PolicySubject`.
 */
export type PersonStatus = "active" | "deactivated" | "anonymized";

/**
 * The minimal shape `can()` needs to identify who is asking.
 *
 * `status` is required, not optional, deliberately: ADR-0006's Negative
 * Consequences note ("JWT revocation latency") calls for checking a
 * `persons.status` flag inside `can()` on every privileged action, so a
 * suspended/anonymized account's still-valid session cannot execute
 * privileged mutations before its JWT expires. Making the field required
 * means a caller of `can()` that forgets to resolve and pass the caller's
 * own status fails to *compile*, rather than silently defaulting to
 * "allowed" at runtime — the fail-closed guarantee holds at the type
 * level, not just the logic level.
 */
export interface PolicySubject {
  id: string;
  status: PersonStatus;
}

/**
 * One active-or-revoked `identity.role_assignments` row, structurally —
 * satisfied directly by a Prisma `RoleAssignment` (or a subset `select`
 * of one) without an explicit mapping step.
 */
export interface RoleAssignmentFact {
  role: Role;
  scopeType: ScopeType;
  scopeId: string | null;
  revokedAt: Date | null;
}

/**
 * The resource an `Action` is being evaluated against. `role` is only
 * meaningful for `role.grant`/`role.revoke` (the role being granted or
 * revoked) — every other action leaves it `undefined`.
 */
export interface Resource {
  type: string;
  scopeType: ScopeType;
  scopeId: string | null;
  /** For "own resource" checks (e.g. a person acting on their own DSAR). */
  ownerId?: string;
  /** For `role.grant` / `role.revoke`: the role being granted/revoked. */
  role?: Role;
}

/**
 * The full action catalog this phase's identity use cases gate through
 * `can()`. Per ADR-0007's Implementation Notes, "the full action catalog
 * lives alongside this type, one entry per privileged mutation/read" —
 * grows as later phases add other bounded contexts' privileged actions.
 */
export const ACTIONS = [
  "role.grant",
  "role.revoke",
  "chapter.create",
  "chapter.assign_lead",
  "dsar.export.request",
  "dsar.erasure.request",
] as const;

export type Action = (typeof ACTIONS)[number];
