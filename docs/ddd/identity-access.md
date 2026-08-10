# Identity & Access

Schema: `identity` · Strategic classification: **Supporting** (see `00-context-map.md` §2)

## Purpose & Scope

Identity & Access owns the single source of truth for **who a Person is**, **which
Chapter they belong to**, **what they are authorized to do** (scoped role
assignments), and **the GDPR machinery that governs their data** (per-purpose
consent, and DSAR export/erasure). It is the upstream context every other module
depends on for authorization decisions and for rendering a Person's public-facing
identity (name, avatar) without ever querying `identity`'s tables directly.

In scope:
- Person registration, profile fields, and account status (active / deactivated /
  anonymized).
- Chapter as a first-class entity (creation, status, chapter-lead pointer).
- Scoped, revocable role assignment (`volunteer`, `mentor`, `chapter_lead`,
  `content_admin`, `org_admin`, `moderator`) at `global`, `chapter`, or `team` scope.
- Age gating (16+ attestation or guardian consent below that age).
- Per-purpose consent recording and revocation.
- DSAR intake, orchestration, and completion tracking (export and erasure).
- Tagging its own privileged actions (role grant/revoke, consent change, DSAR,
  anonymization) into the shared platform-wide audit trail — this context owns
  no audit table of its own (see Ubiquitous Language: Audit Log).

Explicitly out of scope: session/JWT issuance itself (delegated to Supabase Auth —
see §Integration & Anti-Corruption Notes), background-check/screening workflows
(research 05 flags these as likely out of scope for MVP), and any moderation
enforcement action (owned by `moderation`, though `identity` consumes
`UserSuspended`/`UserBanned` to revoke effective access).

## Ubiquitous Language

| Term | Definition |
|---|---|
| Person | The single account record for a human. Never duplicated per role — see Person aggregate below. |
| Public Slug | A separate, non-sequential public identifier (`persons.public_slug`) used in profile/badge URLs instead of the internal ULID, to avoid disclosing account-creation timestamps for people specifically (ADR-0005). |
| Chapter | A city/region-scoped organizational unit (e.g., "Agentics London"). Scoping dimension for opportunities, leaderboards, and roles — not a tenant boundary. |
| Role Assignment | A scoped, revocable grant of exactly one role to one Person. Not a field on Person; a separate, independently-lifecycled record. |
| Scope (`global`/`chapter`/`team`) | The breadth at which a role applies. `chapter` scope references `chapters.id`; `team` scope references a Community-context Team ID (plain ID, no cross-schema FK). |
| Age Attestation | A boolean or date-of-birth-derived fact that a Person is 16 or older, required before most privileges are usable (research 05 item 11). |
| Guardian Consent | A `ConsentRecord` of purpose `guardian_consent`, capturing a parent/guardian's name and email, required when a Person is under 16. |
| Consent Record | A per-purpose, versioned, timestamped grant or revocation of consent, forming the lawful basis for a specific use of a Person's data. |
| DSAR | Data Subject Access Request. An `export` (return all data about a Person) or `erasure` (anonymize a Person and fan out erasure to every context) request, tracked through `pending → processing → completed | failed`. |
| Anonymization | Irreversibly replacing a Person's identifying fields with a placeholder while preserving non-identifying aggregate history. Never a cascade delete. |
| Audit Log | The single, platform-wide `admin.audit_log` (ADR-0014). This context owns no audit table of its own — every privileged action here (role grant/revoke, consent change, DSAR, anonymization) is recorded via the shared `recordAuditEvent()` helper, which tags the corresponding `identity.domain_events` outbox row `audit: true`; the `audit_log_writer` consumer drains it into `admin.audit_log`, same as every other context. |

## Aggregates, Entities & Value Objects

### Person (aggregate root)

The single account record for a human. **Roles are never modeled as separate Person
rows or separate accounts** — a Person can simultaneously be a volunteer, mentor,
chapter lead, content admin, org admin, and moderator; the multiplicity lives in the
child `RoleAssignment` records, not in the Person aggregate's shape.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | Internal identifier; never exposed in a public URL. |
| `publicSlug` | `string` | Unique, exposed in profile/badge URLs instead of `id`. |
| `supabaseAuthId` | `string` | Foreign identity from the auth provider (ACL boundary — see below). |
| `email` | `string` (citext) | Unique. |
| `displayName` | `string` | Public-facing name. |
| `pronouns` | `string \| null` | Optional. |
| `avatarUrl` | `string \| null` | Optional. |
| `bio` | `string \| null` | Optional. |
| `dateOfBirth` | `Date \| null` | Collected where the jurisdiction/flow requires it; nullable to support attestation-only flows. |
| `ageAttested16Plus` | `boolean` | True if the person self-attested 16+ without supplying a DOB. |
| `primaryChapterId` | `string \| null` | Reference to a `Chapter` (real FK — same schema). |
| `status` | `"active" \| "deactivated" \| "anonymized"` | See invariants. |
| `anonymizedAt` | `DateTime \| null` | Set once, by `AnonymizePerson`. |
| `roles` | `RoleAssignment[]` (child collection, own table) | Loaded by ID, not embedded — see Key Use Cases. |

**Invariants enforced by this aggregate:**
1. **One Person per human — no duplicate accounts per role.** Uniqueness is on
   `email` and on `supabaseAuthId`; role multiplicity lives entirely in
   `RoleAssignment`, never by creating a second `Person` row.
2. **Age gate**: a Person must have either a `dateOfBirth` implying 16+, or
   `ageAttested16Plus = true`, or (if under 16) at least one *active*
   `ConsentRecord` of purpose `guardian_consent` — enforced at the
   `RegisterPerson` use case, not purely a DB constraint (the DB constraint is a
   defense-in-depth backstop; see Schema Sketch).
3. **Status transitions are one-directional**: `active → deactivated` is
   reversible (reactivation), but `* → anonymized` is terminal — no code path may
   set `status` away from `anonymized`.
4. **`publicSlug` is immutable once assigned** (changing it would break shared
   badge/profile links — research 01's "portable, shareable badges" finding).

### Chapter (aggregate root)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `name` | `string` | e.g. "Agentics London". |
| `slug` | `string` | Unique, URL-safe. |
| `city` | `string` | |
| `region` | `string \| null` | |
| `country` | `string` | |
| `status` | `"active" \| "inactive"` | |
| `foundedAt` | `Date \| null` | |
| `leadPersonId` | `string \| null` | **Soft reference** to `Person.id` — no DB FK (see Schema Sketch: avoids a circular creation dependency, and is denormalized for display, kept correct by consuming this context's own `RoleGranted`/`RoleRevoked` events for role `chapter_lead`). |

**Invariants:**
1. `slug` is globally unique and immutable once published in any URL.
2. `leadPersonId`, when set, must correspond to a Person holding an active
   `chapter_lead` role assignment scoped to this chapter — enforced at the
   `AssignChapterLead` use case (application-layer, since there's no DB FK to lean
   on for this soft pointer).
3. A Chapter cannot be deleted, only set `inactive` — Opportunities and role
   assignments elsewhere reference it by ID indefinitely for historical/grant
   reporting.

### RoleAssignment (entity, child of Person's authorization lifecycle; own table)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `subjectId` | `string` | References `Person.id` (the person the role is granted to). |
| `role` | enum | `volunteer \| mentor \| chapter_lead \| content_admin \| org_admin \| moderator` |
| `scopeType` | enum | `global \| chapter \| team` |
| `scopeId` | `string \| null` | Required (non-null) iff `scopeType ≠ 'global'`. References a `Chapter.id` (real FK, same schema) or a Community-context Team ID (plain ID, cross-schema, no FK). |
| `grantedBy` | `string` | References `Person.id` of the granter. |
| `grantedAt` | `DateTime` | |
| `revokedBy` | `string \| null` | |
| `revokedAt` | `DateTime \| null` | |

**Invariants:**
1. `scopeType = 'global' ⟺ scopeId IS NULL`; `scopeType ∈ {chapter, team} ⟺ scopeId IS NOT NULL`.
2. Exactly one **active** (`revokedAt IS NULL`) assignment may exist for a given
   `(subjectId, role, scopeType, scopeId)` tuple at a time — re-granting an
   already-active role is a no-op, not a duplicate row.
3. Revocation is a state change on the existing row (`revokedBy`/`revokedAt` set),
   never a delete — the assignment's history is itself an audit artifact.
4. Only a Person holding `org_admin` (global scope) may grant/revoke `org_admin` or
   `moderator`; a `chapter_lead` may only grant/revoke `mentor`/`volunteer` scoped
   to their own chapter — enforced by the shared `can()` policy module, not by this
   table alone.

### ConsentRecord (small aggregate, own table)

Modeled as its own aggregate (not a child of Person) because consent has its own
independent lifecycle, its own compliance-driven query patterns ("show me every
active consent of purpose X"), and must remain queryable/exportable even after a
Person is anonymized (the *fact* that consent was once granted, and when, is itself
part of the compliance record).

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `personId` | `string` | References `Person.id`. |
| `purpose` | enum | `terms_of_service \| newsletter \| photo_publication \| leaderboard_participation \| analytics_cookies \| guardian_consent` |
| `granted` | `boolean` | The decision recorded at `recordedAt`. |
| `policyVersion` | `string` | The exact privacy-policy/ToS version text the Person agreed to. |
| `source` | enum | `signup_form \| settings_page \| guardian_form \| admin_override` |
| `guardianName` | `string \| null` | Required when `purpose = 'guardian_consent'`. |
| `guardianEmail` | `string \| null` (citext) | Required when `purpose = 'guardian_consent'`. |
| `recordedAt` | `DateTime` | |
| `revokedAt` | `DateTime \| null` | |

**Invariants:**
1. `purpose = 'guardian_consent' ⟹ guardianName IS NOT NULL AND guardianEmail IS NOT NULL`.
2. A new consent decision for the same `(personId, purpose)` is a **new row**, never
   an update to a prior row — consent history must be reconstructable for an audit
   (`recordedAt` ordering is the timeline; the most recent non-revoked row for a
   purpose is "current consent").
3. `leaderboard_participation = false` (or revoked) must be honored by
   `gamification`/`community` within one outbox-delivery cycle of
   `ConsentRecorded`/`ConsentRevoked` — this context does not enforce the
   downstream effect itself, only publishes the fact.

### DSARRequest (small aggregate, own table)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (ULID) | |
| `personId` | `string` | The subject of the request. |
| `type` | enum | `export \| erasure` |
| `status` | enum | `pending \| processing \| completed \| failed` |
| `requestedBy` | `string` | Usually `= personId`; may be an `org_admin` acting on the subject's behalf (e.g., a support-desk erasure request), always recorded. |
| `requestedAt` | `DateTime` | |
| `completedAt` | `DateTime \| null` | |
| `exportFileUrl` | `string \| null` | Set for completed `export` requests (a signed, expiring URL — not stored data itself). |
| `failureReason` | `string \| null` | |

**Invariants:**
1. `status` transitions only `pending → processing → (completed | failed)` —
   never backwards, never re-opened (a new request is filed instead).
2. An `erasure` request reaching `completed` implies `Person.status = 'anonymized'`
   and a `PersonAnonymized` event was published — these two facts are made
   consistent in the same transaction as the status transition.
3. Only one **open** (`pending`/`processing`) request of a given `type` may exist
   per `personId` at a time (prevents duplicate concurrent erasure fan-outs).

## Domain Events

All events are written to `identity.domain_events` in the same transaction as the
state change, per the outbox pattern (ADR-0001), and delivered by `graphile-worker`.

| Event | Payload fields | Emitted when | Consumed by |
|---|---|---|---|
| `PersonRegistered` | `personId, publicSlug, email, displayName, primaryChapterId, ageAttested16Plus, registeredAt` | `RegisterPerson` commits a new Person row. | Notifications (welcome email), Gamification (onboarding award), Community (profile card), Admin (reporting seed). |
| `RoleGranted` | `roleAssignmentId, subjectId, role, scopeType, scopeId, grantedBy, grantedAt` | `GrantRole` commits a new active assignment. | Volunteering, Training, Community, Moderation, Admin. |
| `RoleRevoked` | `roleAssignmentId, subjectId, role, scopeType, scopeId, revokedBy, revokedAt` | `RevokeRole` commits a revocation. | Volunteering, Training, Community, Moderation, Admin, Notifications. |
| `ConsentRecorded` | `consentId, personId, purpose, granted, policyVersion, source, recordedAt` | `RecordConsent` commits a new consent row. | Community, Notifications, Admin. |
| `ConsentRevoked` | `consentId, personId, purpose, revokedAt` | A consent row's `revokedAt` is set. | Community, Notifications, Admin. |
| `ChapterCreated` | `chapterId, name, slug, city, country, createdAt` | `CreateChapter` commits. | Volunteering, Community, Gamification, Admin. |
| `DSARRequested` | `dsarId, personId, type, requestedAt` | A new `DSARRequest` is filed. | Admin (compliance dashboard). |
| `PersonAnonymized` | `personId, anonymizedAt` | `AnonymizePerson` completes (erasure DSAR reaches `completed`). | **Volunteering, Training, Gamification, Community, Moderation, Admin** — every context holding person-linked display data scrubs it while preserving aggregate history. |

## Key Use Cases / Application Services

1. **RegisterPerson**
   - *Pre:* A Supabase Auth session exists (see Integration Notes); no `Person`
     with this `supabaseAuthId` or `email` exists yet; either a DOB implying 16+,
     an explicit 16+ attestation, or an accompanying `guardian_consent`
     `ConsentRecord` is supplied in the same request.
   - *Post:* A `Person` row exists with `status = 'active'`; a `terms_of_service`
     `ConsentRecord` exists; `PersonRegistered` is emitted; `recordAuditEvent()`
     tags the same outbox write `audit: true` (`action = 'person.register'`),
     drained into `admin.audit_log` by `audit_log_writer`.

2. **GrantRole**
   - *Pre:* Caller passes `can(caller, 'role.grant', {role, scopeType, scopeId})`
     (an `org_admin` may grant any role at any scope; a `chapter_lead` may only
     grant `mentor`/`volunteer` scoped to their own chapter); no active assignment
     already exists for the target `(subjectId, role, scopeType, scopeId)`.
   - *Post:* A new active `RoleAssignment` row exists; `RoleGranted` is emitted;
     `recordAuditEvent()` tags the outbox write `audit: true`
     (`action = 'role.grant'`, `target_person_id = subjectId`).

3. **RevokeRole**
   - *Pre:* An active `RoleAssignment` matching the target exists; caller passes
     the same scoped `can()` check as granting.
   - *Post:* The row's `revokedBy`/`revokedAt` are set (no delete); `RoleRevoked`
     is emitted; `recordAuditEvent()` tags the outbox write `audit: true`.

4. **RecordConsent**
   - *Pre:* `personId` refers to an active Person; if `purpose = 'guardian_consent'`,
     `guardianName`/`guardianEmail` are supplied.
   - *Post:* A new `ConsentRecord` row exists (never an update to a prior one);
     `ConsentRecorded` is emitted.

5. **RevokeConsent**
   - *Pre:* An active (non-revoked) `ConsentRecord` exists for
     `(personId, purpose)`.
   - *Post:* `revokedAt` is set on that row; `ConsentRevoked` is emitted.

6. **RequestDataExport (DSAR — export)**
   - *Pre:* No other `pending`/`processing` `export` request exists for this
     `personId`.
   - *Post:* A `DSARRequest(type='export', status='pending')` row exists;
     `DSARRequested` is emitted; a `graphile-worker` job is enqueued to assemble the
     export (querying this context's own tables plus, via each context's published
     read API, every other context's data about this person) and, on completion,
     transitions the request to `completed` with a signed `exportFileUrl`
     (expiring — not permanent storage of the export itself).

7. **RequestErasure / AnonymizePerson (DSAR — erasure)**
   - *Pre:* No other `pending`/`processing` `erasure` request exists for this
     `personId`.
   - *Post:* A `DSARRequest(type='erasure')` row is created and driven through
     `processing → completed`; on completion: `Person.status = 'anonymized'`,
     `email`/`displayName`/`bio`/`avatarUrl`/`dateOfBirth` are overwritten with an
     irreversible placeholder, `anonymizedAt` is set, `PersonAnonymized` is
     emitted (fanning out erasure to every other context), and
     `recordAuditEvent()` tags the outbox write `audit: true`. **Aggregate facts this context or others hold about the
     Person (e.g., total approved volunteer hours) are preserved** — only
     identifying fields are scrubbed, never the historical counts grant reporting
     depends on.

8. **CreateChapter**
   - *Pre:* Caller has `org_admin` (global); `slug` is unique.
   - *Post:* A `Chapter` row exists with `status = 'active'`; `ChapterCreated` is
     emitted.

9. **AssignChapterLead**
   - *Pre:* Target Person holds an active `chapter_lead` `RoleAssignment` scoped to
     this chapter (grant the role first, via `GrantRole`, if not).
   - *Post:* `Chapter.leadPersonId` is updated (soft pointer, no FK);
     `recordAuditEvent()` tags the outbox write `audit: true`.


> Schema DDL, tRPC/REST API contract, and integration notes for this context continue in [identity-access-schema-api.md](identity-access-schema-api.md).
