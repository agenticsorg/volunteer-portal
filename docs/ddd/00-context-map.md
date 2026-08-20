# Context Map — Agentics Foundation Volunteer Portal

This document is the map of the system's eight bounded contexts: what each owns, how
they talk to each other, and which ones are strategically Core vs. Supporting vs.
Generic. It is the entry point for `identity-access.md` and
`volunteering-opportunities.md`, and the template every subsequent context document
(`training.md`, `gamification.md`, `community.md`, `moderation.md`,
`notifications.md`, `admin.md`) should follow.

All eight contexts run inside **one deployable Next.js/Node service** (ADR-0001), each
owning one Postgres schema. There are **no cross-schema foreign keys** — every
cross-context reference is a plain ULID column, and every cross-context effect is
either a **domain event** delivered through that schema's `domain_events` outbox table
(drained by `graphile-worker`) or a **synchronous read** through another context's
published tRPC interface (its `index.ts` / Open Host Service). Authorization across all
contexts is a single shared `can(subject, action, resource)` policy module fed by
`identity.role_assignments` — not duplicated per context.

## 1. The Eight Bounded Contexts

| # | Context | Schema | One-line purpose |
|---|---------|--------|-------------------|
| 1 | **Identity & Access** | `identity` | Owns Person identity, Chapter, scoped role assignments, and GDPR consent/DSAR machinery. |
| 2 | **Volunteering & Opportunities** | `volunteering` | Owns Opportunity postings, Shifts, Applications, and the submit→approve/reject Hour Entry workflow that feeds grant reporting. |
| 3 | **Training** | `training` | Owns the video/course library, prerequisites, watch progress, quizzes, and certificates. |
| 4 | **Gamification** | `gamification` | Owns the points ledger, badges, levels, streaks, and leaderboard projections earned as a byproduct of real actions elsewhere. |
| 5 | **Community** | `community` | Owns the activity feed, teams/guilds, kudos/peer recognition, and the member directory. |
| 6 | **Moderation** | `moderation` | Owns reports, block/mute/suspend enforcement, and the append-only moderation audit log. |
| 7 | **Notifications** | `notifications` | Owns delivery of email/in-app/push notifications and per-channel delivery preferences. |
| 8 | **Admin** | `admin` | Owns platform-wide configuration (gamification rule values, feature flags, retention policy), and cross-context reporting/export projections. |

## 2. Strategic Classification (Core / Supporting / Generic)

Per Evans/Vernon strategic design: **Core** = differentiating, where the org should
invest its best engineering effort; **Supporting** = necessary and somewhat custom to
this domain, but not itself the differentiator; **Generic** = a solved problem
available off-the-shelf, invest the minimum needed to integrate it well.

| Context | Classification | Reasoning |
|---|---|---|
| **Volunteering** | **Core** | This *is* the product — opportunity discovery, shift scheduling, and grant-defensible hour tracking are the reason the portal exists. The immutable-once-approved hour-entry workflow (research 05, day-one checklist item 2) is a genuine domain rule worth custom engineering, not something a generic CRM gives you. |
| **Training** | **Core** | Research (03, 06) is explicit that the differentiator is a video library *woven into* gamification and role-gated volunteering, not a bolted-on LMS tab (the Trailhead/Mighty Networks lesson). Prerequisite-gated opportunities and skill-tree training paths are custom domain logic specific to this org's volunteer model. |
| **Gamification** | **Core** | The product brief itself is "gamified... volunteer-management platform" — points/badges/streaks/leaderboards tied to genuine actions (hours approved, courses completed) are the primary retention mechanism research 02 identifies, and the pitfalls research explicitly warns against treating this as generic ("bolted on" gamification backfires). Worth the investment to get subtle (informational, not controlling) reward design right. |
| **Community** | **Core** | Research 02 finds ~40% higher retention when social features pair with structured programs, and explicitly recommends teams/guilds, kudos, and scoped (not global) leaderboards as differentiated, not generic, social design — a stock forum plugin would not deliver this. |
| **Identity & Access** | **Supporting** | Every platform needs identity, so it isn't the differentiator — but the specific invariant this org needs (one Person, pluggable roles, never duplicate accounts per role — research 05 §"Day-One Checklist" item 1) plus GDPR consent/DSAR machinery is custom enough that it can't be treated as a commodity; it's built in-house on top of a generic building block (Supabase Auth). |
| **Moderation** | **Supporting** | Report → review → graduated enforcement (warn/mute/suspend/ban) plus an immutable audit log is a well-understood pattern (research 05 item 9), not a competitive differentiator, but it is a hard day-one requirement for the Community context to be safe to ship — so it earns custom, not generic, treatment. |
| **Admin** | **Supporting** | Cross-context reporting (grant-ready hour exports, org-wide dashboards) and gamification rule configuration are specific to how this org runs, but the underlying mechanics (denormalized reporting projections, feature flags) are standard SaaS admin patterns — low novelty, real necessity. |
| **Notifications** | **Generic** | Delivering an email/in-app/push message given a template and a recipient is a solved problem available from any transactional email/notification vendor. This context should be a thin adapter (template selection + preference checks + delivery-provider call), not a place for custom domain logic. |

## 3. Context Map — Integration Table

Every row is one integration: an event or query published by one context and
consumed by one or more others. **Pattern** follows standard DDD context-mapping
vocabulary:

- **Published Language (event)** — the publisher emits a versioned domain event via its
  `domain_events` outbox; consumers subscribe via `graphile-worker` job handlers and
  translate the payload into their own model. This is the default, and preferred,
  integration mode — it keeps contexts temporally decoupled.
- **Open Host Service (query)** — the consumer calls the publisher's public tRPC
  procedure synchronously (via its `index.ts` interface, per ADR-0001) for a read it
  needs *now*, in-request (e.g., an eligibility check before allowing a write). Used
  sparingly, only where eventual consistency is unacceptable for that specific check.
- **Command (cross-context call)** — the consumer calls a mutating procedure exposed by
  another context (rather than that context reaching in). Used only for Moderation's
  `fileReport`, which by design must be callable from any content-bearing context.
- **Conformist** — a context accepts another's model as-is with no translation, because
  translating would add cost with no benefit (used narrowly below).

| # | Event / Query | Publisher (upstream) | Consumer(s) (downstream) | Pattern | Purpose |
|---|---|---|---|---|---|
| 1 | `PersonRegistered` | Identity | Notifications, Gamification, Community, Admin | Published Language (event) | Welcome email; onboarding badge; public profile card creation; reporting snapshot seed. |
| 2 | `RoleGranted` | Identity | Volunteering, Training, Community, Moderation, Admin | Published Language (event) | Propagate scoped authorization changes (e.g., new `chapter_lead` can now approve hours in that chapter). |
| 3 | `RoleRevoked` | Identity | Volunteering, Training, Community, Moderation, Admin | Published Language (event) | Revoke cached authorization state; notify the affected person. |
| 4 | `ConsentRecorded` / `ConsentRevoked` | Identity | Community, Notifications, Admin | Published Language (event) | Enforce leaderboard-participation opt-out, newsletter subscription state, compliance reporting. |
| 5 | `ChapterCreated` | Identity | Volunteering, Community, Gamification, Admin | Published Language (event) | Seed chapter-scoped opportunity listing, chapter Space, chapter leaderboard. |
| 6 | `PersonAnonymized` | Identity | Volunteering, Training, Gamification, Community, Moderation, Admin | Published Language (event) | DSAR erasure fan-out: every context scrubs/pseudonymizes its own person-linked display data while preserving aggregate counts (grant totals, leaderboard history). |
| 7 | `getPersonSummary(personId)` | Identity | Volunteering, Training, Community, Moderation, Admin | Open Host Service (tRPC query) | Read-only `{displayName, avatarUrl, publicSlug}` for rendering — the sanctioned way to show a name without a cross-schema join (ADR-0001). |
| 8 | `OpportunityPublished` | Volunteering | Community, Notifications, Admin | Published Language (event) | Feed post; digest email; reporting snapshot. |
| 9 | `ShiftScheduled` / `ShiftCancelled` | Volunteering | Notifications, Community | Published Language (event) | Reminder scheduling; feed update. |
| 10 | `ApplicationAccepted` | Volunteering | Community, Notifications, Gamification | Published Language (event) | Feed post ("X is volunteering at Y"); confirmation email; small points for signing up. |
| 11 | `HoursSubmitted` | Volunteering | Notifications | Published Language (event) | Notify the approver a submission is waiting. |
| 12 | **`HoursApproved`** | Volunteering | **Gamification**, Community, Notifications, Admin | Published Language (event) | The central cross-context trigger: Gamification awards points from approved hours (see `volunteering-opportunities.md` §Domain Events); feed post; confirmation email; grant-report projection update. |
| 13 | `HoursRejected` | Volunteering | Notifications | Published Language (event) | Notify volunteer with rejection reason. |
| 14 | `hasCompletedRequiredTraining(personId, courseIds[])` | Training | Volunteering | Open Host Service (tRPC query) | In-request eligibility check before allowing a shift application when an Opportunity has prerequisite courses. |
| 15 | `CourseCompleted` | Training | Gamification, Community, Notifications, Admin | Published Language (event) | Award points/badge; feed post; certificate email; reporting. |
| 16 | `CertificateIssued` | Training | Notifications, Admin | Published Language (event) | Deliver certificate; compliance/training-record reporting. |
| 17 | `VideoPublished` | Training | Community, Admin | Published Language (event) | Feed announcement; content catalog reporting. |
| 18 | `PointsAwarded` | Gamification | Community, Notifications, Admin | Published Language (event) | Feed/profile update; milestone notification; reporting. |
| 19 | `BadgeAwarded` | Gamification | Community, Notifications, Admin | Published Language (event) | Permanent profile badge display (research 02, GitHub/Trailhead model); notification; reporting. |
| 20 | `LevelUp` | Gamification | Community, Notifications | Published Language (event) | Feed celebration; notification. |
| 21 | `getPointsBalance(personId)` / `getLeaderboard(scope)` | Gamification | Community, Admin | Open Host Service (tRPC query) | Render leaderboard/profile widgets and admin reports without owning the ledger. |
| 22 | `KudosGiven` | Community | Gamification, Notifications | Published Language (event) | Optional small point award for peer recognition; notify recipient. |
| 23 | `fileReport(targetType, targetId, reason)` | Moderation (callee) | Community, Training, Volunteering (callers) | Command (cross-context call) | Any content-bearing context routes report flows through Moderation's public procedure rather than owning its own report table. |
| 24 | `UserSuspended` / `UserBanned` | Moderation | Identity, Community, Notifications, Admin | Published Language (event) | Identity revokes active sessions/role effects; Community hides content; user is notified; audit reporting. |
| 25 | `ContentRemoved` | Moderation | Community, Admin | Published Language (event) | Hide/remove the offending post; log for reporting. |
| 26 | `NotificationDeliveryFailed` | Notifications | Admin | Published Language (event) | Operational reporting on delivery health (bounces, provider errors). |
| 27 | `GamificationRuleUpdated` | Admin | Gamification | Published Language (event) | Org admin changes a point value or badge threshold; Gamification reloads its rule config. |
| 28 | `RetentionPolicyTriggered` | Admin | Identity, Training, Moderation | Published Language (event) | Scheduled expiry job fires per data class (research 05 item 6); each context runs its own deletion/anonymization for the data it owns. |

## 4. Project-Wide Ubiquitous Language Glossary

Terms below are used consistently, with the same meaning, across every bounded
context's documentation and code. A context-specific document may extend this
glossary with terms local to that context only.

| Term | Definition |
|---|---|
| **Person** | The single identity record for a human interacting with the portal, owned by `identity`. A Person may simultaneously hold volunteer, mentor, chapter_lead, content_admin, org_admin, and moderator roles — there is never more than one Person row per human, and roles are never modeled as separate accounts. |
| **Chapter** | A first-class, city/region-scoped organizational unit owned by `identity` (e.g., "Agentics London"). Used across contexts as a scoping dimension for opportunities, leaderboards, and role assignments — never a tenant boundary (the system is single-tenant). |
| **ULID** | Universally Unique Lexicographically Sortable Identifier (ADR-0005). The primary-key type for every table in every schema: a 26-character, Crockford Base32, `text`-stored, application-generated, time-sortable string. |
| **Domain Event** | An immutable fact ("X happened"), written to a context's `domain_events` outbox table in the same transaction as the state change it records, and delivered to subscribers by `graphile-worker`. Named in past tense (`HoursApproved`, not `ApproveHours`). |
| **Outbox** | The `domain_events` table pattern: guarantees a state change and its resulting event are committed atomically, decoupling "did we save it" from "did we tell everyone" (no dual-write problem). |
| **Aggregate (root)** | A cluster of entities/value objects treated as one consistency boundary, loaded and saved as a unit, and referenced from outside only by its root's ID. Cross-aggregate references (even within the same schema) are by ID, not by object graph. |
| **Bounded Context** | One of the eight modules in this map; a Postgres schema plus the module code that owns it exclusively. Nothing outside a context may query its tables directly. |
| **Role Assignment** | A scoped, revocable grant of one role to one Person, recorded in `identity.role_assignments(subject_id, role, scope_type, scope_id)`. Scope is `global`, `chapter`, or `team` — never baked into the Person record itself. |
| **Scope (global / chapter / team)** | The breadth at which a role or a leaderboard applies. `global` = org-wide; `chapter` = one Chapter; `team` = one Team (a Community-context aggregate, e.g. a guild). |
| **Volunteer Hour / Hour Entry** | A `volunteering`-owned record of time a Person spent on an Opportunity, moving through `submitted → approved | rejected`. Immutable once `approved` — corrections require a new, separate entry, never an edit (research 05 item 2). |
| **Opportunity** | A `volunteering`-owned posting describing a volunteer task or role, optionally chapter-scoped and optionally gated behind prerequisite Training courses. |
| **Shift** | A `volunteering`-owned scheduled instance of an Opportunity with a start/end time and a capacity, that a Person applies to. |
| **Points / Badge / Level / Streak** | `gamification`-owned recognition primitives, always awarded as a byproduct of a real event elsewhere (`HoursApproved`, `CourseCompleted`), never granted directly by a user action inside `gamification` itself. |
| **Leaderboard** | A `gamification`-owned, scope-bound (never global-only, per research 02) ranked projection over the points ledger. |
| **Consent Record** | An `identity`-owned, per-purpose, versioned, timestamped grant/revocation of consent (e.g., `newsletter`, `photo_publication`, `leaderboard_participation`) — the lawful basis backing any use of a Person's data beyond the core volunteer agreement. |
| **DSAR** | Data Subject Access Request — GDPR-mandated export or erasure request. `identity` owns intake and orchestration (`dsar_requests`); erasure fans out via `PersonAnonymized` to every context holding that Person's data. |
| **Anonymization** | Replacing a Person's identifying fields with an irreversible placeholder while preserving non-identifying aggregate facts (e.g., total approved hours for grant history) — never a cascade delete, which would corrupt downstream reporting. |
| **Moderation Action** | An entry in `moderation`'s append-only audit log recording a report, warning, mute, suspension, ban, or content removal, with actor, target, reason, and timestamp — never mutated or deleted after the fact. |
| **Published Language** | An integration pattern (used throughout §3) where the upstream context defines a versioned event schema that downstream contexts translate into their own model, rather than sharing a database model directly. |
| **Open Host Service** | An integration pattern (used throughout §3) where a context exposes a stable, purpose-built read API (a tRPC query) for other contexts to call synchronously, rather than allowing direct data access. |
| **Anti-Corruption Layer (ACL)** | A translation boundary that prevents an external system's model (e.g., Supabase Auth's JWT claims, a payment-free grant-reporting export format) from leaking into a context's internal domain model. |
