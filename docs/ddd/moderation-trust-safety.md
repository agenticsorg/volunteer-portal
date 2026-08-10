# Moderation & Trust & Safety

## Purpose & Scope

The `moderation` bounded context owns the report intake and review pipeline, and the graduated enforcement ladder (warn → mute → suspend → ban) that keeps the social features (`community`) and the platform at large safe. Research (`05-domain-and-compliance.md` §4, day-one checklist item 9) is explicit that this is a **day-one requirement**, not a hardening pass added after launch: "published code of conduct, in-product report flow with evidence attachment, user block/mute, graduated enforcement ladder... and an immutable moderation audit log."

In scope:
- Filing a Report against any entity in any other bounded context (a Post, a Kudos, a Person, a Team, a Mentorship — see the polymorphic reference design below), with evidence attachments.
- The Report review lifecycle: open → reviewing → resolved/dismissed.
- Issuing, tracking, and revoking `ModerationAction`s — the graduated enforcement ladder — scoped either org-wide or to a single Chapter, matching how `identity.role_assignments` already scopes moderator authority.
- Publishing the facts other contexts need to enforce a sanction locally (`ModerationActionTaken` → Community hides content; → Notifications informs the affected user).

Explicitly out of scope (owned elsewhere, referenced by ID only, no cross-schema FK):
- The reported content itself (a Post's body, a Kudos's note) — owned by `community`. This context stores only a `{type, id}` reference plus an immutable snapshot captured at file-time (see Report invariants) so a moderator can see what was actually reported even if the source is later edited or deleted.
- Who a Person is, their Chapter, and whether a given Person currently holds a moderator `role_assignment` (and at what scope) — owned by `identity`. Every privileged moderation action performs a synchronous `can(subject, action, resource)` policy check against `identity` at call time (Open Host Service pattern); this context never caches or duplicates role state.
- **Personal block/mute** — a volunteer's own preference to stop seeing another volunteer's content or messages. This is a lightweight, self-service, non-punitive setting distinct from the enforcement ladder below; it is owned by the volunteer's own profile settings (`identity`/`community`, not `moderation`) and is out of scope for this document, which covers only moderator-imposed sanctions and the report/audit pipeline.
- **The platform-wide, cross-cutting audit log storage.** Per ADR-0014 §4, the single physical audit table is `admin.audit_log`, populated by a shared `audit_log_writer` graphile-worker consumer that drains *every* schema's `domain_events` outbox for rows tagged `audit: true` — not just this one's. This context is one of several producers into that shared mechanism, not its owner; see "AuditLogEntry" below and Integration & Anti-Corruption Notes for exactly how the two relate.

## Ubiquitous Language

| Term | Definition |
|---|---|
| Report | A volunteer-filed complaint about a specific entity elsewhere in the platform (a Post, a Kudos, a Person, a Team, a Mentorship), with a reason, optional evidence, and a review status. |
| Reported Entity | The polymorphic `{reportedEntityType, reportedEntityId}` pair a Report points at — stored by type+ID only, never joined, per the no-cross-schema-FK rule. |
| Content Snapshot | An immutable copy of the reported entity's user-visible content, captured at file-time and stored on the Report, so review isn't defeated by the reporter or a third party later editing or deleting the original. |
| Evidence Attachment | A value object on a Report: a pointer to an object in Cloudflare R2, plus content type and size — screenshots, additional context files the reporter chose to attach. |
| Report Status | The Report's position in its review lifecycle: `open` → `reviewing` → `resolved` \| `dismissed`. See the state machine below. |
| Moderation Action | One entry on the graduated enforcement ladder — a `warn`, `mute`, `suspend`, or `ban` issued against a target Person by a moderator, with a reason, an optional time-box, and a scope. |
| Enforcement Ladder | The ordered severity progression `warn → mute → suspend → ban` (research 05 §4) — a vocabulary, not a state machine a single action moves through; each `ModerationAction` is independently one rung, and escalation across rungs is a moderator judgment call, not a system-enforced sequence. |
| Scope (moderation action) | The breadth at which a Moderation Action applies: `chapter` (that Chapter's spaces/content only) or `org` (platform-wide) — mirrors `identity.role_assignments` scoping; a chapter-scoped moderator can only issue chapter-scoped actions within their own chapter. |
| Sanction | Informal synonym for an active `ModerationAction` from the target's perspective — "what sanction is currently in effect against this Person." |
| AuditLogEntry | The row shape of the platform-wide, immutable, append-only audit trail (physically `admin.audit_log`, ADR-0014) that records every privileged action across the whole platform — not only moderation's. This document's Report/Moderation Action mutations are producers into that shared log via the outbox, not owners of a separate `moderation`-schema audit table. |

## Aggregates, Entities & Value Objects

### Report (Aggregate Root)
- `id`, `reporterPersonId` (ID-only ref to `identity.person`), `reportedEntityType` (e.g. `'community.post'`, `'community.kudos'`, `'identity.person'`, `'community.team'`, `'community.mentorship'`), `reportedEntityId`, `reportedContentSnapshot` (JSONB — the reported entity's user-visible fields as they existed at file-time, e.g. `{ body, authorDisplayName }` for a Post), `reason` (closed set, app-layer-enforced per ADR-0014's convention of app-layer enums over DB enums for evolvability: `harassment`, `spam`, `hate_speech`, `misinformation`, `safety_concern`, `impersonation`, `other`), `reasonDetail` (free-text elaboration, optional), child value objects **EvidenceAttachment** (0–6 per Report), `status` (`open` \| `reviewing` \| `resolved` \| `dismissed`), `scopeType` / `scopeId` (derived from the reported entity's own scope at file-time — e.g. copied from a Post's `scopeType`/`scopeId` — used to route the Report to the correct moderator queue without a live cross-schema join), `assignedModeratorId` (nullable, ID-only ref), `resolutionNotes` (nullable), `resolutionActionId` (nullable — links to the `ModerationAction` taken as a result, if any), timestamps.

**Invariants:**
1. `reporterPersonId <> reportedEntityId` when `reportedEntityType = 'identity.person'` — a Person cannot report themselves.
2. **`reportedContentSnapshot` is captured once, at file-time, and never re-synced.** This is the anti-corruption/evidentiary guarantee: the reported content can be edited or deleted in its owning context after the Report is filed, and the Report must still show the reviewer what was actually reported.
3. Legal `status` transitions: `open → reviewing` (a moderator claims it), `open → dismissed` (a moderator fast-dismisses an obviously invalid report without formally claiming it), `reviewing → resolved`, `reviewing → dismissed`, `reviewing → open` (a moderator releases their claim, e.g. going on leave). `resolved` and `dismissed` are terminal — a still-live concern needs a new Report.
4. A Report can only move to `resolved` or `dismissed` by the `assignedModeratorId` currently holding the claim (or an `org_admin`), verified via a synchronous `identity` policy check at the scope recorded on the Report.

**Report status state machine:**
```
        ┌────────────────────────────┐
        │                            ▼
      open ───(claim)───▶ reviewing ───(resolve, action taken or validated)───▶ resolved
        │                    │  ▲
        │                    │  └───(release claim)──────────────┘
        └───(fast-dismiss)──▶│
                             └──(no violation found)───▶ dismissed
```
`resolved` and `dismissed` are terminal.

### ModerationAction (Aggregate Root)
- `id`, `actionType` (`warn` \| `mute` \| `suspend` \| `ban` — the enforcement ladder), `targetPersonId` (ID-only ref), `moderatorPersonId` (ID-only ref), `reason`, `relatedReportId` (nullable, in-schema ref to the Report that prompted this action, if any — an action can also be issued proactively without a filed Report), `scopeType` (`org` \| `chapter`), `scopeId` (Chapter ID when `scopeType = 'chapter'`, `NULL` when `org`), `startsAt`, `endsAt` (nullable — the time-box; see invariants), `status` (`active` \| `expired` \| `revoked`), `revokedByPersonId` / `revokedAt` / `revokeReason` (all nullable, set only on early revocation), `createdAt`.

**Invariants:**
1. **`warn` and `ban` never carry a duration** — `warn` is an instantaneous, acknowledgment-only action (`endsAt` must be `NULL`); `ban` is permanent by definition (`endsAt` must be `NULL`; reversal is only ever an explicit `RevokeModerationAction`, never an expiry).
2. `mute` and `suspend` are time-boxed: `endsAt` is either a future timestamp (a bounded sanction) or `NULL` (an indefinite sanction pending manual review) — both are valid, but the choice must be explicit, not defaulted silently.
3. **Scope authority mirrors `identity.role_assignments` scoping.** A moderator whose `role_assignment` is `chapter`-scoped may only create `ModerationAction`s with `scopeType = 'chapter'` and `scopeId` equal to their assigned chapter; only an `org_admin`-or-broader-scoped moderator may create `scopeType = 'org'` actions (including any `ban`, which — being permanent and identity-wide in effect — is always `org`-scoped regardless of where the underlying report originated). Enforced by the synchronous `identity` policy check in `TakeModerationAction`, not by a DB constraint.
4. A `ModerationAction` can only be revoked by its issuing moderator or an `org_admin`; revocation sets `status = 'revoked'` and is itself a new fact (never a silent row deletion).
5. Multiple `ModerationAction`s may be `active` simultaneously against the same `targetPersonId` (e.g. a chapter-scoped `mute` and, later, an org-wide `suspend`) — this context does not collapse them into one "current sanction level"; each is an independent, individually revocable fact, and the *effective* restriction a target experiences is the union of all currently `active` actions, computed by the consuming context (e.g. Community checking "is this person muted in this scope" at write time).

## Domain Events

All events are written to `moderation.domain_events` in the same transaction as the state change that produced them (transactional outbox), then drained by `graphile-worker` for delivery to subscribing modules. Events marked **audit** additionally carry `audit: true` in their payload, which the shared `audit_log_writer` job (ADR-0014 §4) picks up and appends to `admin.audit_log` — this context's contribution to the platform-wide audit trail (see Integration & Anti-Corruption Notes).

| Event | Payload (key fields) | Emitted When | Notable Consumers | Audit |
|---|---|---|---|---|
| `ReportFiled` | `reportId`, `reporterPersonId`, `reportedEntityType`, `reportedEntityId`, `reason` | A Report is created. | Notifications (alert moderator queue) | yes |
| `ReportResolved` | `reportId`, `resolutionActionId?` | `status → resolved`. | Notifications (inform reporter of outcome) | yes |
| `ReportDismissed` | `reportId`, `resolutionNotes` | `status → dismissed`. | Notifications | yes |
| **`ModerationActionTaken`** | `actionId`, `actionType`, `targetPersonId`, `moderatorPersonId`, `scopeType`, `scopeId`, `endsAt` | A `ModerationAction` is created. | **Notifications** (inform the affected user), **Community** (hide/restrict content, enforce mute/suspend/ban at write time) | yes |
| `ModerationActionRevoked` | `actionId`, `revokedByPersonId`, `revokeReason` | A `ModerationAction` moves `active → revoked`. | Notifications, Community (lift the restriction) | yes |
| `ModerationActionExpired` | `actionId` | The `ExpireModerationActions` sweep flips `active → expired` past `endsAt`. | Community (lift the restriction) | yes |

## Key Use Cases / Application Services

1. **FileReport** — validates the anti-self-report invariant, captures `reportedContentSnapshot` and `scopeType`/`scopeId` from the reported entity (via the owning context's Open Host Service read, e.g. `community.getPostSnapshot(postId)`), persists the Report as `open`, emits `ReportFiled`.
2. **ClaimReport** — a moderator with sufficient scope claims an `open` Report (`open → reviewing`, sets `assignedModeratorId`); rejected if the moderator's `role_assignment` scope doesn't cover the Report's `scopeType`/`scopeId`.
3. **ReleaseReportClaim** — the assigned moderator releases a claimed Report back to the queue (`reviewing → open`, clears `assignedModeratorId`).
4. **TakeModerationAction** — validates the acting moderator's scope authority and the duration invariants for the given `actionType`, persists the `ModerationAction`, optionally links `relatedReportId`, emits `ModerationActionTaken`.
5. **ResolveReport** — transitions `reviewing → resolved`, optionally recording `resolutionActionId` (from step 4) and `resolutionNotes`, emits `ReportResolved`.
6. **DismissReport** — transitions `open` or `reviewing → dismissed` with mandatory `resolutionNotes`, emits `ReportDismissed`.
7. **RevokeModerationAction** — validates the caller is the issuing moderator or an `org_admin`, transitions `active → revoked`, records `revokedByPersonId`/`revokeReason`, emits `ModerationActionRevoked`.
8. **ExpireModerationActions** — a scheduled `graphile-worker` job (hourly, mirroring the cadence of ADR-0014's `retention_sweep`) that finds `status = 'active' AND endsAt <= now()` rows, flips them to `expired`, and emits `ModerationActionExpired` per row.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS moderation;

CREATE TYPE moderation.report_status AS ENUM ('open', 'reviewing', 'resolved', 'dismissed');
CREATE TYPE moderation.scope_type AS ENUM ('org', 'chapter');
CREATE TYPE moderation.action_type AS ENUM ('warn', 'mute', 'suspend', 'ban');
CREATE TYPE moderation.action_status AS ENUM ('active', 'expired', 'revoked');

CREATE TABLE moderation.report (
  id                        TEXT PRIMARY KEY,                        -- ULID
  reporter_person_id        TEXT NOT NULL,                           -- identity.person.id, no FK
  reported_entity_type      TEXT NOT NULL,                           -- 'community.post' | 'community.kudos' | 'identity.person' | ...
  reported_entity_id        TEXT NOT NULL,
  reported_content_snapshot JSONB NOT NULL DEFAULT '{}',
  reason                    TEXT NOT NULL,                           -- app-layer closed set, see Ubiquitous Language
  reason_detail              TEXT,
  evidence_attachments       JSONB NOT NULL DEFAULT '[]',            -- [{r2ObjectKey, contentType, sizeBytes}]
  status                    moderation.report_status NOT NULL DEFAULT 'open',
  scope_type                moderation.scope_type NOT NULL,
  scope_id                  TEXT,                                    -- identity.chapter.id, no FK; NULL iff scope_type = 'org'
  assigned_moderator_id     TEXT,                                    -- identity.person.id, no FK
  resolution_notes           TEXT,
  resolution_action_id       TEXT,                                   -- moderation.moderation_action.id; FK added below (avoids ordering issue)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at                TIMESTAMPTZ,
  CHECK ((scope_type = 'org') = (scope_id IS NULL)),
  CHECK (jsonb_array_length(evidence_attachments) <= 6),
  CHECK (NOT (reported_entity_type = 'identity.person' AND reported_entity_id = reporter_person_id))
);
CREATE INDEX idx_report_queue ON moderation.report (status, scope_type, scope_id, id DESC);
CREATE INDEX idx_report_entity ON moderation.report (reported_entity_type, reported_entity_id);
CREATE INDEX idx_report_assigned ON moderation.report (assigned_moderator_id, status);

CREATE TABLE moderation.moderation_action (
  id                     TEXT PRIMARY KEY,
  action_type            moderation.action_type NOT NULL,
  target_person_id       TEXT NOT NULL,                              -- identity.person.id, no FK
  moderator_person_id    TEXT NOT NULL,                              -- identity.person.id, no FK
  reason                 TEXT NOT NULL,
  related_report_id      TEXT REFERENCES moderation.report (id) ON DELETE SET NULL,
  scope_type             moderation.scope_type NOT NULL,
  scope_id               TEXT,                                       -- identity.chapter.id, no FK; NULL iff scope_type = 'org'
  starts_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at                TIMESTAMPTZ,
  status                 moderation.action_status NOT NULL DEFAULT 'active',
  revoked_by_person_id   TEXT,
  revoked_at             TIMESTAMPTZ,
  revoke_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'org') = (scope_id IS NULL)),
  CHECK (action_type NOT IN ('warn', 'ban') OR ends_at IS NULL),      -- warn/ban never time-boxed
  CHECK (action_type <> 'ban' OR scope_type = 'org')                 -- a ban is always org-wide
);
CREATE INDEX idx_moderation_action_target ON moderation.moderation_action (target_person_id, status, starts_at DESC);
CREATE INDEX idx_moderation_action_scope ON moderation.moderation_action (scope_type, scope_id, starts_at DESC);
CREATE INDEX idx_moderation_action_expiry ON moderation.moderation_action (ends_at) WHERE status = 'active' AND ends_at IS NOT NULL;

-- Deferred FK, added after both tables exist (report ↔ moderation_action reference each other).
ALTER TABLE moderation.report
  ADD CONSTRAINT fk_report_resolution_action
  FOREIGN KEY (resolution_action_id) REFERENCES moderation.moderation_action (id) ON DELETE SET NULL;

-- Transactional outbox
CREATE TABLE moderation.domain_events (
  id             TEXT PRIMARY KEY,                                   -- ULID, sortable
  event_type     TEXT NOT NULL,                                      -- e.g. 'ModerationActionTaken'
  aggregate_type TEXT NOT NULL,                                      -- e.g. 'ModerationAction'
  aggregate_id   TEXT NOT NULL,
  payload        JSONB NOT NULL,                                     -- includes `"audit": true` for audit-tagged events
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX idx_domain_events_unprocessed ON moderation.domain_events (id) WHERE processed_at IS NULL;
```

### Implementation-relevant notes

- **`admin.audit_log` is never updated or deleted, by construction, not just convention.** Per ADR-0014 §4, the application's Postgres role holds no `UPDATE`/`DELETE` grant on `admin.audit_log`:
  ```sql
  REVOKE UPDATE, DELETE ON admin.audit_log FROM app_role;
  -- Only INSERT (via the audit_log_writer graphile-worker consumer) and SELECT (for admin/moderator review UIs) remain.
  ```
  This context does not define its own `moderation.audit_log` table and must not — doing so would create a second, divergent "audit log" that fragments the cross-cutting timeline ADR-0014 §"Alternatives Considered" explicitly rejected maintaining per-schema.
- Every `moderation` Postgres role follows the same defense-in-depth grant pattern as every other schema (ADR-0001 Implementation Notes): `GRANT USAGE, SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA moderation TO app_moderation;` — scoped only to this schema's own tables, which by design excludes `admin.audit_log`.
- `reported_content_snapshot` and `evidence_attachments` may contain content later subject to a DSAR erasure request against the *reporter* or the *reported person*. Per ADR-0014 §2's exception carve-out, moderation records referencing a subject as an actor in an enforcement action are retained (not erased) per the `moderation_logs` retention class (1095 days, anonymize-actor-references-only) — they exist to defend a past enforcement decision, which is a legitimate-interest override, not a bug in the erasure pipeline.

## API Contract Sketch

Internal, module-to-frontend traffic is tRPC; the public `/api/v1/*` REST surface is intentionally minimal here (moderation queues are an internal admin surface, not a public API) and is omitted.

```typescript
// src/modules/moderation/api/trpc/router.ts
export const moderationRouter = router({
  fileReport: protectedProcedure
    .input(z.object({
      reportedEntityType: z.enum(['community.post', 'community.kudos', 'identity.person', 'community.team', 'community.mentorship']),
      reportedEntityId: ulidSchema,
      reason: z.enum(['harassment', 'spam', 'hate_speech', 'misinformation', 'safety_concern', 'impersonation', 'other']),
      reasonDetail: z.string().max(2000).optional(),
      evidenceAttachments: z.array(z.object({
        r2ObjectKey: z.string(),
        contentType: z.string(),
        sizeBytes: z.number().int().positive(),
      })).max(6).default([]),
    }))
    .mutation(...), // -> { reportId: string }

  getMyActiveActions: protectedProcedure
    .query(...), // -> ModerationActionDTO[] — a volunteer's own current sanctions, for self-service transparency
});

// Moderator/admin-only procedures
// src/modules/moderation/api/trpc/moderator-router.ts
export const moderationModeratorRouter = router({
  listReportQueue: moderatorProcedure
    .input(z.object({
      status: z.enum(['open', 'reviewing']).default('open'),
      scopeType: z.enum(['org', 'chapter']),
      scopeId: ulidSchema.nullable(),
      cursor: ulidSchema.optional(),
    }))
    .query(...), // -> { reports: ReportSummaryDTO[], nextCursor: string | null }

  claimReport: moderatorProcedure
    .input(z.object({ reportId: ulidSchema }))
    .mutation(...), // -> { status: 'reviewing' } | throws OUT_OF_SCOPE

  releaseReportClaim: moderatorProcedure
    .input(z.object({ reportId: ulidSchema }))
    .mutation(...), // -> { status: 'open' }

  takeModerationAction: moderatorProcedure
    .input(z.object({
      targetPersonId: ulidSchema,
      actionType: z.enum(['warn', 'mute', 'suspend', 'ban']),
      reason: z.string().min(1).max(2000),
      scopeType: z.enum(['org', 'chapter']),
      scopeId: ulidSchema.nullable(),
      endsAt: z.string().datetime().nullable().optional(),   // required for mute/suspend unless intentionally indefinite
      relatedReportId: ulidSchema.optional(),
    }))
    .mutation(...), // -> { actionId: string } | throws OUT_OF_SCOPE | INVALID_DURATION_FOR_ACTION_TYPE

  revokeModerationAction: moderatorProcedure
    .input(z.object({ actionId: ulidSchema, revokeReason: z.string().min(1).max(1000) }))
    .mutation(...), // -> { status: 'revoked' }

  resolveReport: moderatorProcedure
    .input(z.object({ reportId: ulidSchema, resolutionActionId: ulidSchema.optional(), resolutionNotes: z.string().max(2000) }))
    .mutation(...), // -> { status: 'resolved' }

  dismissReport: moderatorProcedure
    .input(z.object({ reportId: ulidSchema, resolutionNotes: z.string().min(1).max(2000) }))
    .mutation(...), // -> { status: 'dismissed' }
});
```

## Integration & Anti-Corruption Notes

**Polymorphic reporting is itself the anti-corruption boundary.** This context never learns the internal schema of a Post, a Kudos, or any other reportable entity — it only ever stores `{reportedEntityType, reportedEntityId}` plus a `reportedContentSnapshot` JSON blob captured through the owning context's own read API at file-time (e.g. `community.getPostSnapshot(postId) -> { body, authorDisplayName, createdAt }`). This is deliberate: it means adding a new reportable entity type in some future context requires only (a) that context exposing a snapshot read function, and (b) extending this context's `reportedEntityType` closed set — never a schema change here, and never a cross-schema join.

**Synchronous reads from Identity, not events.** Authorization (`can(moderatorId, "moderation:claim", report)`, scope-matching a moderator's `role_assignment` against a Report's or a new `ModerationAction`'s `scopeType`/`scopeId`) is always a synchronous Open Host Service call to `identity` at the moment of the mutation — never a cached or event-sourced copy of role state. A role revoked mid-review must take effect on the *next* privileged call, not after some eventual-consistency delay; this is one of the few places in the system where eventual consistency (the outbox's normal mode) is explicitly the wrong tool.

**Outbound: what Community and Notifications consume.** This context never calls into `community` or `notifications` directly — it only writes to `moderation.domain_events`. `graphile-worker` drains that table and dispatches `ModerationActionTaken` (and `ModerationActionRevoked`/`ModerationActionExpired`) to each subscriber's registered handler. `community` subscribes to hide the targeted Post/FeedEntry and to enforce active `mute`/`suspend`/`ban` restrictions at write time (e.g. `CreatePost`/`GiveKudos` check "does the caller have an active `suspend` or `ban` action in this scope" via `moderation.getActiveActionsForPerson(personId, scope)`, an Open Host Service read, not an event subscription, since that check must be current at write time). `notifications` subscribes to inform the affected user and, for `ReportResolved`/`ReportDismissed`, the original reporter.

**Outbound: the shared audit trail.** Every mutation in this context that represents a privileged action (filing a report, claiming/resolving/dismissing it, taking or revoking a `ModerationAction`) is written through the shared `packages/audit` `recordAuditEvent()` helper (ADR-0014 Implementation Notes) in the same transaction as the domain write, which tags the corresponding `moderation.domain_events` row `audit: true`. The platform-wide `audit_log_writer` graphile-worker consumer (running at low-latency 5s polling for audit-tagged events specifically, per ADR-0014) drains that tag into `admin.audit_log` with `actionType` mapped to values like `moderation.report_filed`, `moderation.action_taken.suspend`, `moderation.action_revoked`. This context is a **producer** into that shared, append-only log — it does not read, own, or duplicate it; a quick "what happened, roughly, and when" view queries `admin.audit_log` directly (via `admin`'s own read API), filtered to `resourceType IN ('report', 'moderation_action')`, not a `moderation`-schema table.

**Inbound: `admin`'s read into this context's full evidence-linked detail.** `admin.audit_log` only ever holds a *summary* row per moderation action (per the note above) — it deliberately does not carry evidence attachments, resolution notes, or the full `Report`/`ModerationAction` field set, since ADR-0014 rejects duplicating that detail into a second audit table. When an `org_admin` needs the full picture (e.g. "show me the complete moderation history on this person, with evidence"), `admin` calls a second, dedicated read function this context publishes on its module's public interface: `moderation.queryModerationHistory({ personId?, chapterId?, reportId?, cursor?, limit }): Promise<ModerationHistoryEntryDto[]>`, returning denormalized DTOs that join a `Report` with its resolving `ModerationAction`(s) in-process (never a SQL join across schemas). This is the same Open Host Service pattern as `getActiveActionsForPerson` above — a typed, versioned function this context owns and can evolve, not a table `admin` reads directly.
