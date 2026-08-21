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
  // --- volunteering (docs/ddd/volunteering-opportunities.md) ---
  // `opportunity.create`/`opportunity.manage` share one authorization shape
  // (chapter_lead scoped to the Opportunity's own chapter, or org_admin) —
  // "manage" covers Publish/Close/Archive, which the doc gives identical
  // caller-authority preconditions to (Key Use Case 1's "caller holds
  // chapter_lead (for the target chapter) or org_admin", reused for the
  // close/archive transitions the state machine documents but doesn't
  // re-state authorization for separately).
  "opportunity.create",
  "opportunity.manage",
  // ScheduleShift/CancelShift: same chapter-scoped authority as the parent
  // Opportunity's own management (a Shift has no independent ownership).
  "shift.manage",
  // DecideApplication invariant 4: chapter_lead/mentor scoped to the
  // Opportunity's chapter, or org_admin. Also gates `applications.listForShift`
  // (ADR-0007: "field-level"/read authorization reuses the same primitive).
  "application.decide",
  // HourEntry invariant 2 ("approve/reject requires ... and the approver may
  // not be the same Person as personId"): same chapter-scoped authority as
  // `application.decide`, one action per mutation per the existing
  // `hour_entry.approve`/`hour_entry.reject` split ADR-0007's own Action
  // sample already names.
  "hour_entry.approve",
  "hour_entry.reject",
  // ExportApprovedHours (Key Use Case 10) / the `hourEntries.exportApproved`
  // tRPC query and the `GET /api/v1/hour-entries/export` REST surface built
  // on top of `queryApprovedHours`: "Caller holds org_admin or chapter_lead
  // (scoped to the requested chapter, if any filter is applied)" — the same
  // chapter-scoped-or-org_admin shape as `opportunity.manage`/`shift.manage`,
  // reusing `hasChapterManagementAuthority` in `rules.ts`. This is the API
  // layer's own authorization hook for a read `queryApprovedHours` itself
  // deliberately leaves ungated (see that function's doc comment).
  "hours.export",
  // --- training (docs/ddd/training-learning.md) ---
  // CreateCourse / AddModule / InitiateVideoUpload / PublishCourse: content
  // authoring, gated the same way across the whole aggregate (ADR-0007's
  // role table: `content_admin` at `global` scope "create/edit/publish/
  // unpublish training videos and courses", or `org_admin`). Course has no
  // `chapterId` of its own (docs/ddd/training-learning.md's Course
  // aggregate is org-wide), so every `course.manage` resource is always
  // `scopeType: "global"`.
  "course.manage",
  // ApproveCaptions (Key Use Case 4 / ADR-0010's mandatory publish gate):
  // same `content_admin`/`org_admin` authority as `course.manage`, kept as
  // its own action rather than folded into it so the audit trail
  // (`recordAuditEvent`'s `action` field) distinguishes "edited course
  // metadata" from "signed off on WCAG 2.1 AA caption accuracy" —
  // compliance-relevant actions get their own line in `admin.audit_log`.
  "video.captions.approve",
  // GetPlaybackUrl (ADR-0010: "Playback never uses Cloudflare's public/
  // default UIDs directly ... runs the can(subject, 'video:play', video)
  // policy check"): a learner may play a video attached to a Course they
  // hold an active-or-completed Enrollment in (checked by the use case via
  // `resource.ownerId === subject.id`, since Course/Module carry no chapter
  // scope to check against here), OR `content_admin`/`org_admin` may
  // preview any video regardless of enrollment (caption review, QA).
  "video.play",
  // --- gamification (docs/ddd/gamification.md) ---
  // AdminAdjustPoints (Key Use Case 9) / AdminAwardBadge: both "staff-only
  // escape hatch" mutations with no chapter/team scope of their own (a
  // points/badge correction can target any person regardless of chapter),
  // so both resolve to a `scopeType: "global"` resource — same shape as
  // `course.manage`. Kept as two actions, not one, for the same audit-trail
  // granularity reason `video.captions.approve` is split from `course.manage`.
  "points.adjust",
  "badge.award",
] as const;

export type Action = (typeof ACTIONS)[number];
