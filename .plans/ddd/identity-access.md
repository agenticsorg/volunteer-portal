# Bounded Context: Identity & Access

See [context-map.md](./context-map.md) for the shared `DomainEvent`/
`AuditableEvent` traits, `ActorId`, and the two cross-context
communication mechanisms this file's events rely on. Crate:
`crates/identity-access`. Depends only on `kernel` — per context-map.md's
dependency-direction section, this is the one context every other context
is allowed to depend on directly (for `VolunteerId`, `Role`, and
`VolunteerSummary` only), so it in turn must depend on nothing but
`kernel`. No dependency in either direction on `projects-assignments`,
`hours-verification`, `discord-integration`, `notifications`, or
`compliance-audit`.

## Aggregate: `Volunteer`

```rust
pub struct Volunteer {
    id: VolunteerId,
    name: String,
    email: String,                       // unique, required
    discord_id: Option<DiscordUserId>,    // nullable until linked; Google-first
                                           // signups have no discord_id at all
                                           // until a /link flow completes
    timezone: String,                     // IANA tz name, e.g. "America/Toronto"
    skills: Vec<Skill>,
    availability: Availability,           // free-text/structured slot summary,
                                           // concept.md doesn't specify shape
                                           // beyond "availability" — kept as a
                                           // small value object, not enumerated
                                           // exhaustively here
    status: VolunteerStatus,              // PendingApproval | Approved | Suspended
    role: Role,                           // Volunteer | Lead | Admin
    agreements: Agreements,
    oauth_links: Vec<OAuthLink>,
    created_at: DateTime<Utc>,
}

pub enum VolunteerStatus { PendingApproval, Approved, Suspended }
pub enum Role { Volunteer, Lead, Admin }

pub struct Agreements {
    code_of_conduct_accepted_at: Option<DateTime<Utc>>,
    ip_agreement_accepted_at: Option<DateTime<Utc>>,
    age_attestation_confirmed_at: Option<DateTime<Utc>>,
}
```

`Agreements` is a value object embedded in `Volunteer`, not a separate
aggregate: all three fields are written once, together, at signup
(`concept.md` section 3's form captures them in one submission), and
nothing outside `Volunteer`'s own lifecycle ever needs to query them
independently of the volunteer they belong to.

The age attestation is modeled as a **timestamp of confirmation**, not a
stored date of birth or an age-verification result — `concept.md`
section 3 is explicit that this is a checkbox attestation ("adults only,
stated in the terms"), and that actual age verification is out of scope
for v1 (the compliance surface doubling it would otherwise require). The
domain model must not imply more rigor here than the product actually
does; a `bool`-shaped fact promoted to a `DateTime` only because
`concept.md` section 3 also requires "stored with timestamp" for the
adjacent code-of-conduct acceptance, and reusing the same shape keeps
`Agreements` uniform.

### Invariants

1. **`status` can only become `Approved` if all three fields of
   `Agreements` are `Some`.** This is enforced in `Volunteer::approve`,
   not left to the admin-approval UI to check — a `Volunteer` value with
   `status == Approved` and an incomplete `Agreements` is impossible to
   construct.
2. **`email` is required and must be syntactically valid** (checked at
   the value-object boundary when constructing the `Volunteer` during
   signup — full deliverability is not the domain's concern).
3. **`role` defaults to `Volunteer` at signup and can only change via an
   explicit `Volunteer::change_role` command**, never as a side effect of
   another operation (e.g. approving a volunteer does not implicitly make
   them a lead — becoming a lead is `projects-assignments`' concern,
   assigning them to `Project.leads`, but the `Role::Lead` flag on
   `Volunteer` itself — used for coarse-grained authorization like the
   `AuthUser` extractor's role check — is a separate, explicit admin
   action here). This keeps a single place responsible for "is this
   volunteer *capable* of lead-level actions at all" (Identity & Access)
   versus "is this volunteer a lead *of this specific project*"
   (Projects & Assignments' `project_lead` table) — the two are related
   but not the same fact, and conflating them would let removing someone
   from one project silently strip a role that might still apply
   elsewhere.
4. **`discord_id` is unique across volunteers when present** — enforced
   at the repository/schema level (unique constraint), stated here
   because it is a domain-meaningful fact (two volunteer records can
   never claim the same Discord identity), not merely a database detail.
5. A `Suspended` volunteer cannot be the target of `approve` or
   `change_role` without first transitioning back to `Approved` — status
   transitions are `PendingApproval → Approved`, `Approved ⇄ Suspended`,
   with `PendingApproval → Suspended` not a meaningful transition (there
   is nothing to suspend yet).

## OAuth linking

```rust
pub struct OAuthLink {
    provider: OAuthProvider,        // Discord | Google
    provider_user_id: String,
    linked_at: DateTime<Utc>,
    email_at_link_time: String,     // snapshot, for audit purposes — the
                                     // provider's email at the moment of
                                     // linking, independent of Volunteer.email
                                     // which may later change
}

pub enum OAuthProvider { Discord, Google }
```

**Design recommendation for the account-linking policy (no ADR exists
for this yet — `.plans/adrs/` currently has 0001–0005 only; a teammate may
be drafting the OAuth/account-linking ADR concurrently, and this section
is this document's input to that decision, not a claim that it's already
settled):**

`research-findings.md` flags Auth.js-style `allowDangerousEmailAccountLinking`
as unsafe by default, because it lets an attacker who controls a
same-email account on one provider silently attach to a victim's account
on another. This context's domain model is deliberately built so
**manual, explicit linking is the only path** — there is no constructor
or method that links two `OAuthLink`s purely because their emails match.
Concretely:

- `Volunteer::signup(provider, provider_user_id, ...)` creates a new
  `Volunteer` with exactly one `OAuthLink` (whichever provider was used
  first — Discord or Google, per `concept.md`'s "Discord primary, Google
  fallback").
  - `Volunteer::link_additional_provider(&mut self, provider, provider_user_id, confirming_session: AuthenticatedSession)` — the **only** way a second `OAuthLink` is added. It requires the caller to already hold a valid authenticated session for the *existing* `Volunteer` (i.e., the volunteer is logged in via provider A and explicitly initiates linking provider B from within that session) — never triggered by an unauthenticated OAuth callback matching on email alone. This is what backs the `/link` Discord command flow: a Discord-first joiner runs `/link`, is sent through a Google/Discord OAuth handshake, and the *result* of that handshake is passed to this method only after the handshake itself proves the caller controls both accounts.
- Two `Volunteer` records sharing an email are permitted to exist
  independently (e.g. someone signs up via Google, and separately someone
  — potentially not the same person — connects a Discord account with
  the same email before ever proving control of the Google identity);
  merging them is **not** an automatic operation this aggregate performs.
  If merge-on-request is ever wanted, it should be a distinct,
  admin-mediated command, not implicit linking logic.

If the forthcoming ADR decides to permit automatic linking under a
documented email-verification guarantee (e.g. only when both providers
report `email_verified: true` and match exactly), that would be a new,
narrower constructor (`Volunteer::link_if_verified_email_match(...)`)
added alongside `link_additional_provider`, not a change to the default —
this document's recommendation is that the manual path should remain
available and be the default regardless of what the ADR ultimately adds.

**Added — 2026-08-19** (Phase 2 architecture-consistency review, Prompt
2.2 implementation): the two lookups every login attempt needs *before*
resolving to an authenticated actor — "does an `OAuthLink` already exist
for this `(provider, provider_user_id)`" and ADR-0007's collision check,
"does a different, verified identity already own this email" — cannot go
through the normal `identity_select` RLS policy, since that policy scopes
visibility to `volunteer_id = current_actor_id()`, and by construction
there is no legitimate `current_actor_id()` yet at this point in the
flow. (Prompt 1.5's original Discord callback got this wrong: it scoped
the pre-auth lookup to a freshly-generated random id, which made
`identity_select`/`volunteer_select` invisible to it — silently breaking
lookups for every *returning* volunteer, not just new signups. Fixed in
Prompt 2.2 with a regression test.) `VolunteerRepository` exposes
`find_by_oauth_identity` and `find_by_verified_identity_email`, backed by
two `SECURITY DEFINER` SQL functions (migration
`20260819000005_oauth_identity_lookup_functions.sql`) following the same
narrow-return-shape, pinned-`search_path` pattern established for
`current_actor_role()`/`is_lead_of_project()` — each returns only the
`(volunteer_id[, provider])` the login flow needs, never a full `identity`
or `Volunteer` row. This stays on `VolunteerRepository`/`identity-access`,
not a separate or compliance-audit-adjacent port: identity resolution
during authentication is squarely this context's own job per
context-map.md's ownership table ("Volunteer identity, Discord/Google
OAuth linkage... roles... onboarding agreements"), and the narrow return
shape follows the same principle `VolunteerSummaryQuery` already
establishes below for other contexts' access to `Volunteer` data — full
aggregates never cross a boundary, pre-auth or not.

## Session: infrastructure, not a domain aggregate

**Decision: `Session` is explicitly out of this context's domain model.**
A session (cookie/token, expiry, associated `VolunteerId`) is an
authentication-mechanism concern that has no invariants a domain expert
would recognize as business rules — "is this token still valid" is not a
fact about volunteers, projects, or hours, it's a fact about the HTTP
auth layer. Modeling it as a DDD entity would misrepresent it as domain
knowledge and invite business logic to leak into what should stay a thin
infrastructure concern (per ADR-0002, the `AuthUser` extractor resolves a
session to a `VolunteerId` at the Axum boundary, then everything downstream
operates in terms of `VolunteerId`/`Role`, never a session object). Session
storage/expiry lives in `apps/api`'s infrastructure layer, using
`identity-access`'s `VolunteerRepository::find_by_id` to hydrate the
authenticated volunteer once a session token resolves — this context
exposes the lookup, not the session concept itself.

## Domain events

- `VolunteerOnboarded { volunteer_id, name, email, provider }` — emitted
  on signup. **Not** `AuditableEvent` in the strict sense of recording a
  privileged actor's action (the actor *is* the new volunteer, acting on
  their own not-yet-existing record) — but it is still audit-log-worthy
  as a `Created` record for compliance completeness, so it **does**
  implement `AuditableEvent` with `actor = ActorId::Volunteer(volunteer_id)`
  (self-action) and `action = Created`. Also written to the outbox:
  Notifications' "signup confirmation" trigger consumes it.
- `VolunteerApproved { volunteer_id, approved_by }` — `AuditableEvent`
  (action: `Updated`, actor: the approving admin). Outboxed for
  Notifications (no direct trigger named for this in `concept.md`'s five,
  but relevant to Discord Integration's role reconcile — an approved
  volunteer should get the base Discord role on the next reconcile tick).
- `OAuthAccountLinked { volunteer_id, provider }` — `AuditableEvent`
  (action: `Updated`). Not outboxed to Notifications (no trigger for this
  in `concept.md`'s five); Discord Integration consumes it only
  indirectly, by virtue of `discord_id` now being resolvable for role
  sync once the linked provider is Discord.
- `RoleChanged { volunteer_id, previous_role, new_role, changed_by }` —
  `AuditableEvent` (action: `Updated`). Outboxed — this is the signal
  Discord Integration's reconcile job treats as "a reconcile is due
  sooner than the next scheduled tick" per
  [discord-integration.md](./discord-integration.md).

## Repository ports

```rust
#[async_trait]
pub trait VolunteerRepository: Send + Sync {
    async fn find_by_id(
        &self, tx: &mut Transaction<'_, Postgres>, id: VolunteerId,
    ) -> Result<Option<Volunteer>, RepoError>;

    async fn find_by_discord_id(
        &self, tx: &mut Transaction<'_, Postgres>, discord_id: DiscordUserId,
    ) -> Result<Option<Volunteer>, RepoError>;

    async fn find_by_email(
        &self, tx: &mut Transaction<'_, Postgres>, email: &str,
    ) -> Result<Option<Volunteer>, RepoError>;

    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, volunteer: &mut Volunteer,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}
```

**Amended — 2026-08-19** (Phase 1 architecture-consistency review, Prompt
1.3 implementation): `volunteer` is `&mut Volunteer`, not `&Volunteer` as
originally written here. Draining `Volunteer`'s internal pending-events
buffer (via `take_events(&mut self)`, see the "Domain events" section)
requires a mutable borrow — `save()` cannot return the aggregate's
recorded events under Rust's ownership rules with only a shared
reference. This is a Rust-mechanics correction, not a change to any
invariant or behavior; see context-map.md's matching amendment, which
also flags that every other context file's `Repository::save` signature
needs the same correction when implemented.

As with every repository port in this model (see
[projects-assignments.md](./projects-assignments.md) and
[hours-verification.md](./hours-verification.md)), the transaction is
always caller-supplied by the `apps/api` scoped-transaction helper
(ADR-0004's `SET LOCAL app.current_user_id` wrapper) — this repository
never opens its own connection.

### `VolunteerSummary` — the read port other contexts consume

```rust
pub struct VolunteerSummary {
    pub id: VolunteerId,
    pub name: String,
    pub role: Role,
    pub status: VolunteerStatus,
}

#[async_trait]
pub trait VolunteerSummaryQuery: Send + Sync {
    async fn summary(
        &self, tx: &mut Transaction<'_, Postgres>, id: VolunteerId,
    ) -> Result<Option<VolunteerSummary>, RepoError>;

    async fn approved_summaries(
        &self, tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<VolunteerSummary>, RepoError>;  // backs Discord Integration's
                                                       // "who should have the base
                                                       // role" reconcile query
}
```

This is deliberately the *only* thing exposed as a stable cross-context
port beyond the bare `VolunteerId`/`Role` types — full `Volunteer`
aggregates (with `Agreements`, `oauth_links`, etc.) never cross a crate
boundary. `LeadMembershipQuery` ("is this volunteer a lead of *this
project*") is explicitly **not** this context's responsibility per
context-map.md's ownership table; it lives in
[projects-assignments.md](./projects-assignments.md) against the
`project_lead` table, and must not be duplicated here even though both
concern "leadership" in the colloquial sense — see invariant 3 above for
why the two facts are kept separate.
