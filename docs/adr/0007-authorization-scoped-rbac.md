# ADR-0007: Authorization — Scoped RBAC with a Central Policy Module

## Status
Accepted — 2026-08-10

## Context
The org's explicit requirement (research brief, day-one checklist item 7 in research 05: "field-level access control") plus the org's own structure drives this decision: **volunteers organize into city chapters**, and a role like "team lead" or "chapter lead" is only meaningful *within* that chapter or team — a London chapter lead has no authority over the Silicon Valley chapter's opportunities, hour approvals, or moderation queue. A flat, org-wide RBAC model (`role: "lead"` with no scope) cannot express this without either (a) creating a distinct role per chapter (`london_lead`, `sv_lead`, ...), which doesn't scale as chapters are added and duplicates permission logic per role, or (b) granting chapter leads org-wide privileges as a shortcut, which violates least-privilege and creates real risk given the platform holds volunteer PII (research 05, GDPR) and moderation actions (research 05, day-one checklist item 9: append-only moderation log with actor and reason — actor's authority must be verifiable and bounded).

Additional forces:
- **Person-centric identity with pluggable roles** (research 05, day-one checklist item 1) means a single `identity.persons` row can simultaneously be a volunteer, a mentor, a chapter lead for one chapter, and (rarely) an org admin — roles are additive, not a single enum column on the person.
- **Privileged actions need an audit trail** (research 05, checklist item 12: "audit trail on every privileged action — hour approval, role grant, data export, moderation") — which requires that every mutation go through one identifiable authorization checkpoint that can be logged, rather than ad hoc `if (user.role === "admin")` checks scattered across 8 bounded-context modules.
- **Field-level access control** (research 05, checklist item 7: "only screening admins see background-check status; leaderboards/social profiles expose an explicitly whitelisted public field set") means authorization isn't only about *which mutations* a subject can call, but also *which fields* of a read result they can see — the policy model needs to cover both.
- **Tenancy is single-tenant with Chapter as a scoping entity, not full multi-tenant SaaS** (canonical decision, elaborated in ADR-0008) — so the scope hierarchy is exactly two meaningful levels below "global": chapter, and team (a sub-unit within a chapter, e.g., an event-organizing sub-team). This is a bounded, known hierarchy, not an arbitrary tree.
- **Small team, no dedicated security engineering** (research 04) argues against standing up a general-purpose policy engine (OPA, Casbin-as-a-service) whose learning curve and operational overhead exceed what a two-level scope hierarchy with six roles actually requires.

## Decision
Implement **scoped role-based access control (RBAC)**: a fixed set of named roles, each role assignment carrying an explicit **scope** (`global`, `chapter`, or `team`) and a **scope ID** identifying *which* chapter or team the assignment applies to. All authorization decisions — every mutation and every sensitive read — pass through a single policy-enforcement function, `can(subject, action, resource)`, implemented once in a shared `packages/authz` module and imported by every bounded-context module's tRPC procedures and REST route handlers. No module implements its own ad hoc permission check.

### Role list and scope semantics

| Role | Typical scope | What it can do |
|---|---|---|
| `volunteer` | `global` (implicit, every authenticated person) | View public opportunities/training, apply to opportunities, log own hours, view own badges/profile, participate in community features (post, comment) subject to moderation rules, edit own profile fields. |
| `mentor` | `global` or `chapter` | Everything `volunteer` can, plus: view mentee progress/training completions for assigned mentees, post in mentor-only community spaces, endorse skill tags. |
| `chapter_lead` | `chapter` (scoped to exactly one chapter per assignment; a person can hold multiple `chapter_lead` assignments for multiple chapters) | Everything `volunteer` can within their chapter, plus: create/edit/cancel opportunities scoped to their chapter, approve/reject hour-log submissions for their chapter's opportunities, manage their chapter's roster (invite, remove non-lead members), view their chapter's non-sensitive volunteer list, assign `team` sub-scope leads within their chapter. **Cannot** act on another chapter's resources, view org-wide reporting, or grant/revoke `org_admin`/`content_admin`/`moderator` roles. |
| `content_admin` | `global` | Create/edit/publish/unpublish training videos and courses, manage badge/course metadata, edit public content pages. Does not imply hour-approval or moderation authority. |
| `moderator` | `global` or `chapter` | View reported content, apply the graduated enforcement ladder (warn → mute → suspend → ban per research 05 §4) within their scope, view/append to the moderation audit log. A chapter-scoped moderator acts only on that chapter's community spaces; a global moderator acts platform-wide. |
| `org_admin` | `global` only | Superset: role grants/revocations at any scope, org-wide reporting/exports (grant-ready hour exports per research 05 checklist item 3), screening/background-check status visibility (checklist item 7), system configuration, and everything every other role can do. Requires MFA (ADR-0006). |

Every person has an implicit baseline `volunteer` capability once authenticated (not stored as an explicit `role_assignments` row — it's the default for any authenticated `identity.persons` record in good standing) plus zero or more explicit rows in `role_assignments` layering additional roles and scopes on top.

### Data model

```sql
-- identity schema
CREATE TABLE identity.role_assignments (
  id          text PRIMARY KEY,               -- ULID, ADR-0005
  subject_id  text NOT NULL REFERENCES identity.persons(id),
  role        text NOT NULL CHECK (role IN (
                'mentor','chapter_lead','content_admin','moderator','org_admin'
              )),
  scope_type  text NOT NULL CHECK (scope_type IN ('global','chapter','team')),
  scope_id    text NULL,                      -- NULL iff scope_type = 'global'
  granted_by  text NOT NULL REFERENCES identity.persons(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL,
  revoked_by  text NULL REFERENCES identity.persons(id),

  CONSTRAINT scope_id_matches_scope_type CHECK (
    (scope_type = 'global' AND scope_id IS NULL) OR
    (scope_type IN ('chapter','team') AND scope_id IS NOT NULL)
  )
);

CREATE INDEX idx_role_assignments_subject ON identity.role_assignments(subject_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_role_assignments_scope ON identity.role_assignments(scope_type, scope_id) WHERE revoked_at IS NULL;
```

`scope_id` references a `volunteering.chapters.id` or `volunteering.teams.id` **by ID only, no FK constraint** — consistent with the canonical no-cross-schema-FK rule, since `chapters`/`teams` live in the `volunteering` schema, not `identity`. Validity of `scope_id` (does this chapter actually exist) is checked at write time by the application (a role-grant procedure calls into the volunteering module's read API before inserting the assignment) rather than enforced by Postgres.

Rows are **never deleted**, only `revoked_at`-stamped — this *is* the audit trail for role grants/revocations (research 05 checklist item 12) and is itself queried directly rather than requiring a separate audit-log table for this specific event type.

### The `can()` policy module

```typescript
// packages/authz/src/can.ts
import type { Person } from "@portal/identity";

export type ScopeType = "global" | "chapter" | "team";
export type Role = "volunteer" | "mentor" | "chapter_lead" | "content_admin" | "moderator" | "org_admin";

export interface Resource {
  type: string;              // e.g. "opportunity", "hour_entry", "training_video"
  scopeType: ScopeType;      // what scope this resource lives in
  scopeId: string | null;    // e.g. the chapter_id an opportunity belongs to
  ownerId?: string;          // for "own resource" checks (e.g. a person's own hour log)
}

export type Action =
  | "opportunity.create" | "opportunity.edit" | "opportunity.cancel"
  | "hour_entry.approve" | "hour_entry.reject" | "hour_entry.create_own"
  | "content.publish" | "content.edit"
  | "moderation.act" | "moderation.view_log"
  | "role.grant" | "role.revoke"
  | "person.view_screening_status" | "report.export_org_wide";
  // ...full action catalog lives alongside this type, one entry per privileged mutation/read

interface PolicyRule {
  action: Action;
  allow: (subject: Person, resource: Resource, assignments: RoleAssignment[]) => boolean;
}

const rules: PolicyRule[] = [
  {
    action: "opportunity.edit",
    allow: (subject, resource, assignments) =>
      hasRoleInScope(assignments, "org_admin", "global", null) ||
      (resource.scopeType === "chapter" &&
        hasRoleInScope(assignments, "chapter_lead", "chapter", resource.scopeId)),
  },
  {
    action: "hour_entry.approve",
    allow: (subject, resource, assignments) =>
      hasRoleInScope(assignments, "org_admin", "global", null) ||
      (resource.scopeType === "chapter" &&
        hasRoleInScope(assignments, "chapter_lead", "chapter", resource.scopeId)),
  },
  {
    action: "hour_entry.create_own",
    allow: (subject, resource) => resource.ownerId === subject.id,
  },
  {
    action: "person.view_screening_status",
    allow: (subject, resource, assignments) =>
      hasRoleInScope(assignments, "org_admin", "global", null),
  },
  {
    action: "moderation.act",
    allow: (subject, resource, assignments) =>
      hasRoleInScope(assignments, "org_admin", "global", null) ||
      hasRoleInScope(assignments, "moderator", "global", null) ||
      (resource.scopeType === "chapter" &&
        hasRoleInScope(assignments, "moderator", "chapter", resource.scopeId)),
  },
  // ... one rule per Action, exhaustively — CI fails if an Action has no matching rule
];

function hasRoleInScope(
  assignments: RoleAssignment[], role: Role, scopeType: ScopeType, scopeId: string | null
): boolean {
  return assignments.some(a =>
    a.role === role && a.revokedAt === null &&
    a.scopeType === scopeType &&
    (scopeType === "global" || a.scopeId === scopeId)
  );
}

export async function can(
  subject: Person, action: Action, resource: Resource
): Promise<boolean> {
  const assignments = await getActiveRoleAssignments(subject.id); // cached per-request
  const rule = rules.find(r => r.action === action);
  if (!rule) throw new Error(`No policy rule defined for action "${action}"`); // fail closed
  const allowed = rule.allow(subject, resource, assignments);
  await auditLog.record({ subject: subject.id, action, resource, allowed }); // ADR-0012-style audit sink
  return allowed;
}
```

Every tRPC mutation procedure and every sensitive query field calls `can()` before doing anything else:
```typescript
export const approveHourEntry = protectedProcedure
  .input(z.object({ hourEntryId: ulidSchema }))
  .mutation(async ({ ctx, input }) => {
    const entry = await getHourEntry(input.hourEntryId);
    const allowed = await can(ctx.person, "hour_entry.approve", {
      type: "hour_entry", scopeType: "chapter", scopeId: entry.chapterId,
    });
    if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });
    // ... perform approval
  });
```

## Consequences

### Positive
- **Chapter/team scoping is a first-class, structural concept**, not a bolt-on `if (chapter matches)` check duplicated per module — matches the org's actual shape (research 01: independently organized city chapters) directly.
- **One audit point for every privileged action**: because `can()` is the sole gate and it logs every decision (allow and deny), the "audit trail on every privileged action" requirement (research 05, checklist item 12) is satisfied structurally rather than by convention, and a security review only needs to inspect one module, not eight.
- **Additive roles match the person-centric model**: a person's authority is the union of their `role_assignments` rows plus the implicit `volunteer` baseline — no duplicate-account or single-role-column problem, consistent with ADR-0006's separation of auth identity from domain identity.
- **Fail-closed by construction**: `can()` throws if an `Action` has no matching rule, so a newly added mutation that a developer forgot to write a policy rule for fails safe (denies/errors) instead of silently allowing.
- **Field-level checks reuse the same primitive**: read resolvers (e.g., a chapter roster query) call `can(subject, "person.view_screening_status", resource)` per field or per record set to decide whether to include sensitive fields in the response, rather than needing a separate field-masking system.

### Negative / Trade-offs
- **Per-request role lookup cost**: every `can()` call needs the subject's active role assignments. Mitigated by caching `getActiveRoleAssignments(subject.id)` for the lifetime of a single request/tRPC batch (already-fetched-once pattern), invalidated on next request — acceptable staleness window given role changes are infrequent, deliberate admin actions, not high-frequency data.
- **Rule table is hand-maintained TypeScript, not declarative policy-as-data**: adding a new role or a new fine-grained condition (e.g., "chapter leads can only approve hours for opportunities they didn't create themselves") means editing and redeploying application code, not updating a policy file at runtime. Accepted trade-off given team size and the exhaustiveness check (CI fails on missing rules) that keeps this safe despite being code, not config.
- **No dynamic/attribute-based conditions beyond what's encoded**: e.g., "only during business hours" or "only if the volunteer has fewer than N active suspensions" style conditions require writing them explicitly into a rule's `allow` function rather than being expressible generically. Acceptable now; revisit if such conditions proliferate (see Alternatives).
- **Two-level scope hierarchy is hardcoded** (`global > chapter > team`) — adding a third scoping level (e.g., a "region" grouping several chapters) later requires a migration and touching every rule that reasons about scope, not just a config change. Judged low-risk given the org's actual, stable structure (research 01 shows no region-level organizational layer today).

## Alternatives Considered

- **Attribute-Based Access Control (ABAC) via a general policy engine (Open Policy Agent / Rego, or Casbin)**: rejected for v1. OPA/Rego is genuinely powerful for expressing arbitrary attribute conditions, but it introduces a second language (Rego) and, in most deployment patterns, a second running process (the OPA sidecar/server) that the modular-monolith architecture (single deployable Next.js/Node service) explicitly avoids adding for other concerns (message brokers, etc. — see ADR-0009's parallel reasoning). For a fixed, small role catalog (six roles) and a two-level scope hierarchy known in advance, the expressiveness ABAC/OPA buys isn't yet needed, and the operational and learning-curve cost (research 04: no dedicated security staff) isn't justified. Trigger to reconsider: if authorization conditions grow numerous, dynamic, or need to be edited by non-engineers (e.g., program staff wanting to tune rules without a deploy), OPA becomes worth the operational cost.
- **Per-role boolean flags directly on the `persons` row** (e.g., `is_chapter_lead: boolean`, `is_admin: boolean` columns): rejected — cannot express scope (which chapter?) without either one flag per chapter (unbounded schema growth as chapters are added) or a side table anyway, at which point it's just a worse version of `role_assignments`. Also fails the person-centric "pluggable roles" requirement directly, since it hardcodes a fixed role set into the identity table rather than letting roles be assigned/revoked as data.
- **Scope-free RBAC with role names encoding scope** (`london_chapter_lead`, `sv_chapter_lead` as distinct enum values): rejected — role definitions (what a chapter lead *can do*) would need to be duplicated per chapter-specific role name, and adding a new chapter would require a code change (adding a new enum value and matching rules) rather than an `INSERT` into `role_assignments`. Directly contradicts the requirement that chapter scoping be dynamic data, not code.
- **Full external IdP-managed authorization (e.g., Auth0 Fine-Grained Authorization, or encoding roles as JWT custom claims from Supabase)**: rejected as the primary mechanism — JWT claims are fine for coarse, rarely-changing facts but are a poor fit for a scoped role set that changes as chapter leadership changes, since claims are only refreshed on token reissue, and Supabase Auth (ADR-0006) is deliberately kept to authentication, not domain authorization, to avoid coupling a third-party auth vendor's data model to the org's evolving chapter/team scoping rules.

## Implementation Notes

**Package layout**: `packages/authz/` exports `can()`, the `Role`/`Action`/`Resource` types, and `hasRoleInScope()`. Every bounded-context module (`identity`, `volunteering`, `training`, `gamification`, `community`, `moderation`, `notifications`, `admin`) depends on `packages/authz`, never the reverse — `authz` has zero dependencies on domain modules beyond the shared `Person` type, keeping it a true cross-cutting layer.

**CI exhaustiveness check**: a test iterates every value of the `Action` union type and asserts a matching entry exists in `rules`, failing the build if a new action was added without a policy rule (TypeScript's exhaustive-switch pattern or a runtime `Set` comparison against the enum).

**Role grant/revoke procedure** itself goes through `can()` too — `role.grant` and `role.revoke` are actions like any other, gated so that only `org_admin` can grant `org_admin`/`content_admin`/global `moderator`, while `chapter_lead` can grant `team`-scoped sub-leads within their own chapter (a narrower, chapter-scoped `role.grant` rule) — preventing privilege escalation where a chapter lead grants themselves org-wide authority.

**Audit sink**: `can()`'s `auditLog.record()` call writes to a shared, append-only audit table (or emits a domain event into the `identity` schema's outbox — ADR-0009 — consumed by an audit-log projector), capturing both allowed and denied attempts, since denied privileged-action attempts are themselves a moderation/security-relevant signal.

**Testing**: policy rules are unit-tested directly (given a subject with assignments X, resource Y, action Z, expect allow/deny) independent of any HTTP/tRPC layer, and a smaller set of integration tests confirm tRPC procedures actually call `can()` before mutating (e.g., a lint rule or a runtime dev-mode assertion that every `protectedProcedure.mutation` handler's first non-input-parsing line is a `can()` call).
