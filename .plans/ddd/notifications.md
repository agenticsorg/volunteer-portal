# Bounded Context: Notifications

Crate: `crates/notifications`. Depends on `kernel` and `identity-access`
only (for `VolunteerId`, `Role`, and volunteer contact info via
`identity-access`'s public read types) — no compile-time dependency on
`projects-assignments`, `hours-verification`, or `discord-integration`.
Everything this context reacts to arrives via the `domain_event_outbox`
poller described in [context-map.md](./context-map.md); the one exception
(the scheduled meeting-reminder trigger and the verification-letter-ready
trigger) is detailed below.

## No aggregate root — this context is reactive, not a source of truth

Unlike every other context in this model, Notifications does not own a
long-lived business aggregate. Its job is to *react* to state changes
owned elsewhere (`VolunteerOnboarded`, `AssignmentApproved`,
`HoursApproved`) or to time (`meeting reminder`), decide whether and what
to send, and record the outcome. Modeling a `Notification` as a rich
aggregate with its own invariants would be manufacturing domain complexity
that doesn't exist here — there is no multi-step lifecycle to protect
beyond "attempted, then sent or failed." What this context does persist is
a flat delivery-log record:

```rust
pub struct NotificationAttempt {
    id: NotificationAttemptId,
    trigger_type: TriggerType,          // SignupConfirmation | AssignmentApproved
                                         // | HoursApproved | MeetingReminder
                                         // | VerificationLetterReady
    recipient: VolunteerId,
    channel: Channel,                   // Email | DiscordDm
    source_event_id: Option<Uuid>,      // the outbox event id that caused this
                                         // attempt; None for the two triggers
                                         // that aren't sourced from the outbox
                                         // (see below)
    status: AttemptStatus,              // Pending | Sent | Failed
    attempted_at: DateTime<Utc>,
    error: Option<String>,
}

pub enum TriggerType {
    SignupConfirmation,
    AssignmentApproved,
    HoursApproved,
    MeetingReminder,
    VerificationLetterReady,
}

pub enum Channel { Email, DiscordDm }
pub enum AttemptStatus { Pending, Sent, Failed }
```

`channel` is `Email` for all five triggers in v1 (`concept.md` section 7
lists only email triggers); `DiscordDm` is included now because
`concept.md` section 6 separately lists "notifications to DM or channel"
for the same underlying events (assignment approved, hours approved,
meeting reminders) as a Discord-side concern. Per
[context-map.md](./context-map.md)'s ownership table, this context decides
**what** to send and **when**; `discord-integration.md` owns the
**delivery mechanics** of actually calling Discord's REST API to DM a
user, the same way an email provider SDK is infrastructure under this
context's control. Concretely: this context's `EmailProvider` port (below)
has a Discord-side sibling port, `DiscordDmSender`, implemented by
`discord-integration` and injected here at the composition root — this
context still owns the `NotificationAttempt` record and retry/failure
bookkeeping regardless of channel.

## Mapping the 5 triggers to their event source

The five triggers are not uniform in how they're sourced — three are
ordinary outbox consumers, one is time-based, and one breaks the "event
comes from an aggregate's repository save" pattern entirely.

1. **Signup confirmation** → consumes `VolunteerOnboarded` (owned by
   `identity-access.md`) via the outbox poller.
2. **Assignment approved** → consumes `AssignmentApproved` (owned by
   `projects-assignments.md`) via the outbox poller.
3. **Hours approved** → consumes `HoursApproved` (owned by
   `hours-verification.md`) via the outbox poller.
4. **Meeting reminder** → **not event-driven**. This is a scheduled/
   time-based trigger, not a reaction to a state change. `projects-
   assignments.md`'s `Project` aggregate carries an `EventSchedule {
   next_occurrence_at, recurrence_note }` (added specifically to support
   this trigger) for `project_type == Event` projects, but **that file
   does not yet declare a query port for it** — as of this writing
   `projects-assignments.md`'s `ProjectRepository` trait has no method
   exposing upcoming occurrences. This is a needed addition, flagged here
   rather than assumed silently:

   ```rust
   // Needed on projects-assignments's ProjectRepository (or a dedicated
   // read-model port) — not yet present in projects-assignments.md as of
   // this writing:
   #[async_trait]
   pub trait UpcomingEventOccurrencesQuery: Send + Sync {
       async fn find_occurring_within(
           &self, tx: &mut Transaction<'_, Postgres>, window: Duration,
       ) -> Result<Vec<EventOccurrence>, RepoError>;
   }

   pub struct EventOccurrence {
       pub project_id: ProjectId,
       pub project_name: String,
       pub next_occurrence_at: DateTime<Utc>,
       pub attendee_ids: Vec<VolunteerId>,   // from Assignment, Attendee + Contributor
                                              // (host) participation_mode both remind —
                                              // reminders aren't gated by the
                                              // event-hours distinction, everyone
                                              // signed up should be reminded
   }
   ```

   This context runs a Tokio-scheduled job (interval, e.g. hourly) that
   calls `UpcomingEventOccurrencesQuery::find_occurring_within` with a
   fixed lookahead window (e.g. 24h), and for each `EventOccurrence` not
   already reminded for *this specific* `next_occurrence_at` value, sends
   a reminder to every `attendee_id` and inserts a `NotificationAttempt`
   per recipient with `source_event_id: None` (there is no outbox event —
   `trigger_type` plus `(project_id, next_occurrence_at)` recorded in the
   attempt's context is what prevents duplicate sends across job runs; see
   Idempotency below).

5. **Verification letter ready** → the one trigger that breaks the
   "domain event from an aggregate's repository save" pattern used
   everywhere else. Per `hours-verification.md`'s "Verification letters: a
   process, not a stored entity" section, `VerificationLetterService`
   produces an ephemeral `VerificationLetterDraft` that is **never
   persisted** (`concept.md`: "rendered on demand," never stored) — there
   is no aggregate, no `save()` call, and therefore no natural place for a
   repository to hand back a `Vec<Box<dyn DomainEvent>>`. Instead: the
   `apps/api` HTTP handler that serves the on-demand PDF generation
   request, immediately *after* the Typst render succeeds, constructs a
   lightweight `VerificationLetterGenerated { volunteer_id, range,
   generated_at }` event and writes it **directly to the
   `domain_event_outbox`** table (in its own small transaction, since
   there's no aggregate transaction to piggyback on) rather than via a
   repository's `save()`. This is fine precisely because the event
   carries no state worth auditing beyond what `HoursApproved`/
   `HoursAdjusted` already captured — it is a pure "tell the volunteer
   their letter is ready" signal, not a compliance record of what the
   letter contained. It therefore does **not** implement `AuditableEvent`
   (contrast with the events below).

## Domain events this context owns

```rust
pub struct NotificationSent {
    attempt_id: NotificationAttemptId,
    trigger_type: TriggerType,
    recipient: VolunteerId,
}

pub struct NotificationFailed {
    attempt_id: NotificationAttemptId,
    trigger_type: TriggerType,
    recipient: VolunteerId,
    error: String,
}
```

**Neither `NotificationSent` nor `NotificationFailed` implements
`AuditableEvent`.** An earlier draft of this file proposed extending
`AuditEntityType` with a `NotificationAttempt` variant so failures could
be captured to `audit_log`; [compliance-audit.md](./compliance-audit.md)
(the context that owns `AuditEntityType`'s vocabulary) deliberately
declined to add it, on the grounds that delivery telemetry — did an email
send succeed or fail — doesn't answer "what domain state changed and who
changed it," which is what `audit_log` exists for (`concept.md` section 9
scopes the audit log to "admin actions and hour adjustments," not delivery
infrastructure), and that commingling high-volume delivery outcomes with
compliance evidence would dilute the log. This file defers to that
decision rather than reintroducing the variant. Delivery failure — for any
of the five triggers, including "verification letter ready" — remains
fully visible and queryable, just through this context's own
`NotificationAttemptRepository::find_by_recipient` (and an equivalent
admin-facing "recent failures" query) rather than through `audit_log`.
That is a deliberate scope line, not a visibility gap: an admin
investigating "did volunteer X get their letter email" queries
Notifications, not Compliance & Audit, the same way they'd check delivery
logs rather than an audit trail for any other transactional email system.
`NotificationSent`/`NotificationFailed` are still persisted via
`NotificationAttempt` regardless of this decision — they just aren't
double-written to `audit_log`.

## Repository / port shapes

```rust
#[async_trait]
pub trait NotificationAttemptRepository: Send + Sync {
    async fn save(
        &self, tx: &mut Transaction<'_, Postgres>, attempt: &NotificationAttempt,
    ) -> Result<(), RepoError>;

    async fn find_by_recipient(
        &self, tx: &mut Transaction<'_, Postgres>, recipient: VolunteerId,
    ) -> Result<Vec<NotificationAttempt>, RepoError>;   // admin/debugging visibility

    async fn exists_for_source_event(
        &self, tx: &mut Transaction<'_, Postgres>, source_event_id: Uuid,
    ) -> Result<bool, RepoError>;                        // idempotency check, event-sourced triggers

    async fn exists_for_occurrence(
        &self, tx: &mut Transaction<'_, Postgres>,
        recipient: VolunteerId, project_id: ProjectId, next_occurrence_at: DateTime<Utc>,
    ) -> Result<bool, RepoError>;                        // idempotency check, meeting reminder
}
```

`EmailProvider` is the one place a concrete provider SDK (Resend/Postmark,
per ADR-0010) is referenced by type, and only at the `apps/api` composition
root — nowhere else in this crate's domain or application layer:

```rust
#[async_trait]
pub trait EmailProvider: Send + Sync {
    async fn send(
        &self, to: &str, template: EmailTemplate, data: TemplateData,
    ) -> Result<ProviderMessageId, EmailError>;
}
```

`DiscordDmSender` (implemented by `discord-integration`, per the ownership
split described above):

```rust
#[async_trait]
pub trait DiscordDmSender: Send + Sync {
    async fn send_dm(
        &self, discord_user_id: &str, message: DmContent,
    ) -> Result<(), DiscordDeliveryError>;
}
```

## Idempotency

The outbox gives at-least-once delivery (per
[context-map.md](./context-map.md)), and the meeting-reminder job can in
principle overlap or double-fire across scheduled ticks. Two distinct
idempotency checks, matching the two trigger sourcing mechanisms above:

- **Outbox-sourced triggers (1–3, and the writes made for 5):** before
  calling `EmailProvider::send`, the handler calls
  `NotificationAttemptRepository::exists_for_source_event(source_event_id)`
  (backed by a unique constraint on `(trigger_type, recipient,
  source_event_id)` in the `notification_attempt` table) — a redelivered
  outbox row is a no-op past that check, recorded as already handled
  rather than resent.
- **Time-sourced trigger (4, meeting reminder):** there is no
  `source_event_id` to key off. Instead
  `exists_for_occurrence(recipient, project_id, next_occurrence_at)` is
  checked (unique constraint on `(trigger_type, recipient, project_id,
  next_occurrence_at)`) — this is why `EventOccurrence` above carries the
  exact `next_occurrence_at` timestamp through to the reminder job: it is
  the natural dedup key for "have we already reminded this person about
  *this* occurrence," robust to the scheduled job running more often than
  once per occurrence window.

## Delivery failure handling

Matches `build-roadmap.md` Phase 7's exit criterion directly: a failed
`EmailProvider::send` or `DiscordDmSender::send_dm` call results in a
`NotificationAttempt` with `status: Failed` and a populated `error`,
publishes `NotificationFailed` (captured to `audit_log` per above), and is
retried on the **next** scheduled poller/job tick rather than looped
synchronously in the request path — consistent with the outbox poller's
general at-least-once, eventually-consistent delivery model described in
context-map.md. No alerting mechanism (e.g. paging an admin) is modeled
here; that is an operational/observability concern for the `apps/api`
composition root and infrastructure setup, not a domain concept.

## Brand system note (non-domain)

`concept.md` section 7's brand constraints (cream `#faf8f3` background,
orange `#ff5a1f` CTAs, navy `#1a2a3a` cards, cyan `#5cb8e8` accent labels,
no palette substitutions, no em/en dashes in copy) are template-rendering
concerns, not domain data — they live in this crate's `infra` submodule as
static template assets, not as fields on `NotificationAttempt` or any
domain type. Mentioned here only so a reader doesn't go looking for a
`BrandTheme` value object that deliberately doesn't exist.
