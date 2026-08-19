# Bounded Context: Discord Integration

Crate: `crates/discord-integration`. Depends on `kernel` and
`identity-access` (for `VolunteerId`, `Role`, `VolunteerSummary`); consumes
read-model ports implemented by `identity-access` and
`projects-assignments` rather than depending on those crates' aggregate
internals. This context owns no long-lived domain state of its own beyond
a small link-confirmation record and a reconcile run log — see
[Repository/port shapes](#repositoryport-shapes) below.

This context is an **anti-corruption layer (ACL)** around the Discord REST
API. Per `concept.md` section 6, it runs as a **scheduled reconcile job**
(not a persistent Gateway bot) plus an **HTTP interactions endpoint** for
the `/link` slash command — REST-only, via `twilight-http`/`twilight-model`
(ADR-0008, being written concurrently, is expected to confirm this; this
file does not re-decide it).

## The ACL boundary

No `twilight_model::guild::Role`, `Guild`, `Member`, or interaction payload
type ever appears in a domain function signature, a port trait, or a
domain event in this context. They are confined to an `infra` submodule
(`discord-integration::infra::twilight_client`) that implements the
domain-facing ports defined below. The domain speaks its own vocabulary:

```rust
/// Internal, Discord-shape-free representation of "what role concept a
/// volunteer should hold" — never a Discord role snowflake ID.
pub enum VolunteerFacingRole {
    BaseVolunteer,
    ProjectMember(ProjectId),
}

pub struct DesiredRoleSet {
    pub volunteer_id: VolunteerId,
    pub discord_id: DiscordUserId,        // newtype over u64/String snowflake,
                                            // defined in this crate — this is the
                                            // one Discord-shaped primitive allowed
                                            // to cross the boundary, since it's an
                                            // opaque identifier, not an API shape
    pub roles: Vec<VolunteerFacingRole>,
}
```

Translation to and from Discord's actual role IDs happens through a port,
implemented in `infra` against a guild-specific configuration mapping
(**not hardcoded** — a `discord_role_mapping` config/table associating
`VolunteerFacingRole` variants with real role snowflakes per guild, since
role IDs are guild-specific and only knowable at deploy/config time):

```rust
#[async_trait]
pub trait DiscordRoleMapping: Send + Sync {
    /// Translates internal role concepts to concrete Discord role IDs for
    /// the configured guild. Returns an error if a `ProjectMember` role
    /// has no configured mapping (e.g. a brand-new project whose Discord
    /// role hasn't been created yet) — reconcile skips that volunteer's
    /// project-role line and logs it, rather than failing the whole run.
    async fn resolve(&self, role: &VolunteerFacingRole) -> Result<DiscordRoleId, MappingError>;
}
```

`DiscordRoleId` (also a snowflake newtype) and `DiscordRoleMapping` live in
this crate's public domain module, not `infra` — they're the ACL's
*output* vocabulary, deliberately still not `twilight_model` types, so a
future swap of the Discord HTTP client crate touches only `infra`.

## Domain service: `RoleReconciler`

The core of the scheduled reconcile job. Computes desired state entirely
from this system's own data (never from what Discord currently reports),
fetches actual state live from Discord, diffs, and applies the delta.

```rust
pub struct RoleReconciler<A, P, M, C> {
    approved_volunteers: A,   // ApprovedVolunteersQuery (identity-access)
    active_memberships: P,    // ActiveProjectMembershipQuery (projects-assignments)
    role_mapping: M,          // DiscordRoleMapping (this crate, infra-backed)
    discord_client: C,        // DiscordRoleReadWrite port (this crate, infra-backed)
}

impl<A, P, M, C> RoleReconciler<A, P, M, C>
where
    A: ApprovedVolunteersQuery, P: ActiveProjectMembershipQuery,
    M: DiscordRoleMapping, C: DiscordRoleReadWrite,
{
    pub async fn reconcile(&self, tx: &mut Transaction<'_, Postgres>) -> ReconcileReport {
        let desired = self.compute_desired_state(tx).await;     // step 1
        let actual = self.discord_client.fetch_current_roles().await; // step 2, live REST read
        let delta = diff(&desired, &actual);                    // step 3, pure function
        let outcome = self.discord_client.apply_delta(&delta).await; // step 4, REST writes
        ReconcileReport::from(outcome)
    }
}
```

**Ports this service depends on, declared here and implemented by the
owning contexts** (per context-map.md's direct-call mechanism — this
context does not depend on `identity-access`'s or `projects-assignments`'s
aggregates, only these read-model traits):

```rust
#[async_trait]
pub trait ApprovedVolunteersQuery: Send + Sync {
    /// Every volunteer with status == Approved and a linked discord_id.
    async fn approved_with_discord_link(
        &self, tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, DiscordUserId)>, RepoError>;
}

#[async_trait]
pub trait ActiveProjectMembershipQuery: Send + Sync {
    /// Every (volunteer, project) pair with an Approved Assignment whose
    /// participation_mode is Contributor — reusing projects-assignments.md's
    /// exact term. Attendee-mode event assignments are excluded here by the
    /// same construction-time guarantee described there, so this context
    /// never has to re-derive or special-case event attendance itself.
    async fn active_contributor_memberships(
        &self, tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, ProjectId)>, RepoError>;
}
```

### Idempotency / self-healing

`reconcile()` always recomputes `desired` from source-of-truth tables and
diffs against a **live** read of Discord's actual state — it never
consults a locally cached "what we last set" record. This is what makes it
idempotent and self-healing by construction (build-roadmap.md Phase 5's
exit criterion: manually desync roles, run job, confirm correction): a
manually-removed role, a role added by a human moderator by mistake, or a
role change missed during downtime are all just found as part of `actual`
on the next run and corrected by the diff, with no special "did we already
handle this" state to get out of sync itself.

## Application service: `/link` command handling

Modeled as an application service, not an aggregate — it has no state of
its own beyond the identity-linking side effect it triggers in Identity &
Access.

```rust
pub struct LinkCommandHandler<V> {
    volunteers: V,   // a port exposed by identity-access, e.g. VolunteerLinkingPort
}

impl<V: VolunteerLinkingPort> LinkCommandHandler<V> {
    /// `interaction` is already parsed and cryptographically verified
    /// (Ed25519 signature check) at the Axum HTTP layer per Discord's
    /// interactions webhook contract — that verification is infra, not
    /// domain, and never reaches this method. This method receives only
    /// the already-extracted `discord_user_id`.
    pub async fn handle_link(
        &self, tx: &mut Transaction<'_, Postgres>, discord_user_id: DiscordUserId,
        requesting_volunteer: VolunteerId,
    ) -> Result<DiscordLinkCompleted, LinkError> {
        self.volunteers.confirm_discord_link(tx, requesting_volunteer, discord_user_id).await
    }
}
```

This context is a **caller** of Identity & Access here (matching
context-map.md's arrow direction — Identity & Access is upstream of
everyone). It does not itself construct or mutate a `Volunteer` or
`OAuthLink` — it identifies the Discord-side actor and hands off to
Identity & Access's own linking rule (manual/explicit confirmation, per
that context's design) to decide whether the link is accepted. If
`identity-access.md` isn't finalized yet at implementation time, the
`VolunteerLinkingPort` name and signature above should be reconciled
against whatever that file settles on rather than assumed final here.

## Domain events

**Consumed** (from the outbox, per context-map.md's reactive mechanism):
`RoleChanged`, `AssignmentApproved`, `VolunteerApproved`. These are
treated purely as a signal to **run the reconcile job sooner than the next
scheduled tick**, never as a trigger for a synchronous per-event Discord
API call — `concept.md` section 6 is explicit that this must stay a
scheduled reconcile model, not real-time webhooks, and mixing in an
event-driven fast path that calls Discord synchronously would quietly
reintroduce the real-time-webhook failure mode (partial application,
ordering issues) the scheduled design exists to avoid. Consuming these
events only ever does `schedule_next_run_at = min(schedule_next_run_at,
now + short_debounce)`.

**Emitted:**
- `DiscordRoleReconciled { run_id, desynced_count, corrected_count, ran_at }`
  — **not** `AuditableEvent`. A routine reconcile run, even one that made
  corrections, is an operational/system event, not an admin action or a
  change to a person's own data in the sense `audit_log`'s
  `actor_id`/`entity_type` model captures (its "actor" is `System`, and
  ADR-0005's `entity_type` enum — `volunteer`/`project`/`assignment`/
  `hour_entry` — has no natural slot for "a batch of Discord roles").
  Logged instead to this context's own `reconcile_run_log` (see below),
  which is the right home for high-frequency, system-actor,
  operational-monitoring data that would otherwise dilute the
  compliance-focused audit trail.
- `DiscordLinkCompleted { volunteer_id, discord_id, linked_at }` — **is**
  `AuditableEvent` (action: `Custom("discord_linked")`, entity_type:
  `Volunteer`, entity_id: the volunteer's id). Unlike a reconcile run,
  this changes a specific person's identity data at their own request (or
  an admin's, for `/link`-initiated cases) — exactly the kind of thing
  ADR-0005's `audit_log` exists for. This does mean `entity_type` stays
  `Volunteer` rather than growing a `discord_link` variant — deliberate,
  since the audited fact is "this volunteer's identity data changed," and
  `entity_type` classifying by the affected aggregate (not by which
  context triggered the change) keeps the audit log's taxonomy stable as
  more contexts touch `Volunteer` over time.

## Repository/port shapes

This context is asymmetric relative to the others: it is a **consumer and
executor**, not a source of truth for domain state that other contexts
need to query. It exposes almost nothing outward; it mostly *depends on*
ports owned elsewhere (`ApprovedVolunteersQuery`, `ActiveProjectMembershipQuery`,
`VolunteerLinkingPort`, all declared by/for the owning context, not this
one). The two things it does own and persist:

```rust
/// One row per link confirmation — supports admin-facing "who linked
/// when" visibility and re-run idempotency (don't re-emit
/// DiscordLinkCompleted for an already-linked pair).
#[async_trait]
pub trait DiscordLinkRepository: Send + Sync {
    async fn find_by_discord_id(
        &self, tx: &mut Transaction<'_, Postgres>, discord_id: DiscordUserId,
    ) -> Result<Option<DiscordLinkRecord>, RepoError>;

    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, record: &DiscordLinkRecord,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}

/// Operational log for reconcile runs — not audit_log (see above).
#[async_trait]
pub trait ReconcileRunLogRepository: Send + Sync {
    async fn record(
        &self, tx: &mut Transaction<'_, Postgres>, report: &ReconcileReport,
    ) -> Result<(), RepoError>;

    async fn latest(&self, tx: &mut Transaction<'_, Postgres>) -> Result<Option<ReconcileReport>, RepoError>;
}
```

Both take a caller-supplied `&mut Transaction<'_, Postgres>` per
context-map.md's RLS-safety convention, even though `reconcile_run_log`
itself is `System`-actor data with looser RLS needs than volunteer-scoped
tables — consistency of the repository calling convention across the
codebase is worth more here than the marginal benefit of a special case.

## Failure handling

**Reconcile job:** Discord REST calls can fail (rate limits, transient
5xx, a revoked bot permission). `apply_delta` is best-effort per role
change, not all-or-nothing — one failed role grant/revoke is logged in the
`ReconcileReport` and does not abort the rest of the batch. Because the
job is idempotent (see above), any failed correction is simply retried
automatically on the next scheduled tick with no special retry logic
needed beyond "run again."

**DM/channel notifications:** `concept.md` section 6 lists Discord
DM/channel delivery for assignment-approved, hours-approved, and
meeting-reminder notices alongside role sync, but this file draws a
narrower boundary than "Discord owns all Discord-shaped output." This
context owns **delivery mechanics only** — a `DiscordNotificationSender`
port (`send_dm(discord_id, content) -> Result<(), DiscordApiError>`,
implemented against `twilight-http` in `infra`) — while **what to say and
when to trigger it** belongs to `notifications.md`, exactly as an email
provider adapter is infrastructure under Notifications' control rather
than Notifications' logic living inside the email provider's crate.
Rationale: the five triggers, their content, their idempotency handling,
and their delivery-failure bookkeeping (`NotificationAttempt`) are a
single coherent concern already modeled once in `notifications.md`;
duplicating that lifecycle here for the subset of triggers that happen to
go to Discord instead of email would split one concern across two
contexts for no benefit. This context's `DiscordNotificationSender` is
simply one more implementation of whatever channel-delivery port
`notifications.md` defines, wired in at the `apps/api` composition root
alongside the `EmailProvider` implementation — if `notifications.md`
doesn't yet name that exact port when read, this is a note for that file
to reconcile against, not a contradiction to resolve here.
