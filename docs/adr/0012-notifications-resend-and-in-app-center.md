# ADR-0012: Notifications via Resend (Transactional Email) + In-App Notification Center, Driven by the Domain-Event Outbox

## Status
Accepted — 2026-08-10

## Context
Multiple bounded contexts need to tell a user something happened: `volunteering` (hour submitted for approval, hour approved/rejected), `training` (video ready to caption, training reminder, module completed, certificate issued), `gamification` (badge earned, leaderboard milestone), `community` (mention, reply), `moderation` (report resolved, enforcement action taken against you). Left unmanaged, this becomes N contexts each independently deciding how to send email and each duplicating "did the user opt into this" logic.

Two domain-compliance constraints from `05-domain-and-compliance.md` directly shape this:
- **Per-purpose consent is a first-class requirement** (checklist item 4): "separate flags + timestamps + versioned policy text for newsletters, photo/name publication, leaderboard participation, analytics cookies." Notification preferences are the same category of concern — GDPR requires a lawful basis per processing purpose, and transactional/operational email (hour-approval, security) has a different basis (contract/legitimate interest) than promotional/digest email (consent), so the preference model must distinguish these, not treat "notifications" as one on/off switch.
- **Learning analytics and behavioral data are personal data** (§13 of the same doc) — badge/leaderboard notifications surface gamification data and must respect the leaderboard opt-out already required elsewhere in the platform.

Architecturally, every cross-context side effect in this system already flows through the transactional outbox pattern established for cross-schema integration: each schema owns a `domain_events` table, written in the same transaction as the state change, drained by graphile-worker (the canonical Postgres-native job runner used for video-encode callbacks and other async work — see ADR-0010). Notifications are the textbook consumer of that pattern: they are inherently a fan-out reaction to events owned by other contexts, and must never be triggered by a direct synchronous call from e.g. `volunteering` into a `notifications` module (which would violate the no-cross-schema-FK, modular-monolith boundary).

## Decision
**Resend is the transactional email provider. A dedicated `notifications` Postgres schema backs an in-app notification center. Every notification — email or in-app — is triggered by consuming domain events from the outbox of the owning context, never by direct synchronous calls between contexts.**

- **Email (Resend)**: used for transactional, individually-triggered email — verification/welcome, hour-approval/rejection, badge-earned, training-reminder, DSAR-export-ready, moderation-action-taken. Templates are React Email components (TypeScript, consistent with the canonical stack) rendered server-side and sent via Resend's API. Domain (`mail.volunteer.agentics.org` or similar) is SPF/DKIM/DMARC-verified in Resend for deliverability.
- **In-app notification center**: a `notifications.notifications` table + bell/inbox UI, is the system of record for **every** notification-worthy event regardless of whether email was also sent — a user who has emails off for a category should still see it in-app. This is deliberate: email is a delivery *channel*, the in-app center is the notification *record*.
- **Delivery-preference model**: `notifications.preferences(user_id, notification_type, in_app_enabled, email_enabled, digest_frequency, consent_recorded_at, policy_version)`. Notification types are grouped into two consent classes:
  - **Operational** (hour-approval, security alerts, moderation actions against you, DSAR export ready): always in-app; email defaults **on** but can be turned off per-type — lawful basis is contract/legitimate interest, not consent, so there is no forced opt-in gate, but the user retains channel control.
  - **Engagement** (badge earned, leaderboard movement, training reminders, digest summaries): email defaults **on** at signup only for a narrow "essential" subset (training reminders tied to a compliance deadline); broader engagement email is **opt-in**, consent recorded with `consent_recorded_at` + `policy_version` exactly like the other per-purpose consent flags in the platform, satisfying the GDPR lawful-basis requirement.
- **Digest vs. real-time**: each notification type declares a default delivery mode (`realtime | daily_digest | weekly_digest`) and the user can override it per type. Real-time sends fire immediately off the event; digest types are accumulated in `notifications.notifications` and a graphile-worker scheduled job (`sendDigestEmails`, cron-like recurring task) batches unsent, digest-eligible notifications per user into a single Resend email at the configured cadence (default: daily digest at 08:00 chapter-local time where known, else UTC).
- **Outbox integration**: the `notifications` schema does not read other schemas' tables directly. A graphile-worker job (`processDomainEvent`) polls/consumes each owning schema's `domain_events` table (e.g., `volunteering.domain_events`, `training.domain_events`, `gamification.domain_events`) for event types registered in a `notifications` routing table, and for each match inserts a row into `notifications.notifications` plus enqueues an email-send job if the user's preferences allow it. This keeps `notifications` a pure consumer with no cross-schema foreign keys, consistent with the modular-monolith boundary rule.
- **Unsubscribe/compliance**: every marketing/engagement email includes a one-click unsubscribe (Resend's list-unsubscribe header support) that flips the relevant `email_enabled` preference directly — required for CAN-SPAM/GDPR and for keeping Resend sender reputation healthy.

## Consequences

### Positive
- Single, auditable path from "something happened" to "user was told," via the same outbox/graphile-worker mechanism already used for video encoding and every other cross-context reaction — no bespoke pub/sub or direct-call spaghetti between schemas.
- Per-type, per-channel preference model satisfies the GDPR per-purpose-consent requirement natively rather than bolting it on later; consent versioning (`policy_version`) gives an audit trail if the privacy policy changes.
- In-app notification center as the system of record means email delivery failures (bounces, spam-filtering) never mean a user "never knew" — they can always see it in-app.
- Resend's developer experience (React Email templates, good deliverability tooling, webhook events for bounces/complaints) fits the TypeScript-everywhere stack directly — no separate template language.
- Digest batching reduces email fatigue and unsubscribe risk for high-frequency event types (leaderboard movement) while keeping compliance-critical types (training reminders, hour approval) real-time.

### Negative / Trade-offs
- Added latency between "event happens" and "user notified" for anything not real-time — acceptable for engagement notifications, but real-time types must be carefully classified correctly or a compliance-relevant notification (e.g., a training-completion-deadline reminder) could silently end up in a digest and arrive too late.
- The outbox-consumer pattern means `notifications` must maintain a routing table mapping event types across every other schema's event vocabulary — a new domain event type in any context requires a corresponding `notifications` routing entry, or it silently produces no notification (mitigated by a CI check / lint rule that flags new `domain_events` event types with no registered consumer).
- Two systems of record for "was the user told" (Resend's delivery status vs. `notifications.notifications` read/unread state) require reconciliation via Resend webhooks (bounce, complaint) to keep preference state accurate (e.g., auto-disabling email on hard bounce).
- Small-team operational cost: monitoring email deliverability (bounce/complaint rate, domain reputation) is now an ongoing responsibility, not a "set and forget" integration.

## Alternatives Considered
- **SendGrid / Postmark for transactional email** — both mature, capable alternatives. Rejected in favor of Resend specifically because Resend's React Email integration matches the canonical TypeScript-everywhere stack (templates as typed React components, not a separate templating DSL or a vendor's drag-and-drop editor), and its API/DX is oriented toward exactly this "developer sends transactional email from a Node/TS app" use case. Postmark remains a credible fallback if Resend deliverability or pricing becomes a problem at scale.
- **Direct synchronous cross-schema calls instead of outbox consumption** (e.g., `volunteering`'s hour-approval handler directly calling a `notifications.send()` function in the same request) — rejected because it violates the established no-cross-schema-FK / modular-monolith isolation rule, couples request latency to notification-send latency (email API calls or DB writes to another schema inside the same transaction/request), and loses the durability/retry guarantees graphile-worker gives the rest of the async pipeline. The outbox keeps every context's write path fast and independently deployable/testable.
- **Third-party notification-infrastructure platform (e.g., Knock, Courier)** — rejected: these add a paid external dependency and another sub-processor to the GDPR processor inventory for a capability (preference model + digest batching + in-app center) that is straightforward to build directly on top of Postgres + graphile-worker, which the platform already runs for every other async workload. Revisit only if notification-routing complexity grows well beyond the current bounded-context count.

## Implementation Notes

**Schema (`notifications` schema)**
```sql
CREATE TABLE notifications.notifications (
  id                TEXT PRIMARY KEY,           -- ULID
  user_id           TEXT NOT NULL,
  notification_type TEXT NOT NULL,              -- 'hour_approved', 'badge_earned', 'training_reminder', ...
  source_context     TEXT NOT NULL,             -- 'volunteering' | 'training' | 'gamification' | 'community' | 'moderation'
  source_event_id   TEXT NOT NULL,              -- correlates back to the owning schema's domain_events.id
  payload           JSONB NOT NULL,             -- rendering data: {hourEntryId, approverName, ...}
  channel_sent      TEXT[] NOT NULL DEFAULT '{}', -- e.g. {'in_app','email'}
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications.notifications (user_id, read_at, created_at DESC);

CREATE TABLE notifications.preferences (
  user_id             TEXT NOT NULL,
  notification_type   TEXT NOT NULL,
  in_app_enabled      BOOLEAN NOT NULL DEFAULT true,
  email_enabled       BOOLEAN NOT NULL DEFAULT true,
  digest_frequency    TEXT NOT NULL DEFAULT 'realtime'
                        CHECK (digest_frequency IN ('realtime','daily_digest','weekly_digest')),
  consent_recorded_at TIMESTAMPTZ,
  policy_version      TEXT,
  PRIMARY KEY (user_id, notification_type)
);

CREATE TABLE notifications.event_routing (
  source_context     TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  notification_type  TEXT NOT NULL,
  default_channel    TEXT[] NOT NULL DEFAULT '{in_app,email}',
  consent_class      TEXT NOT NULL CHECK (consent_class IN ('operational','engagement')),
  PRIMARY KEY (source_context, event_type)
);
```

**Outbox consumer (graphile-worker task, illustrative)**
```ts
// runs on a recurring schedule per source schema, or triggered via LISTEN/NOTIFY on insert
export async function processDomainEvents(schemaName: SourceSchema) {
  const events = await db.$queryRaw`
    SELECT * FROM ${schemaName}.domain_events
    WHERE processed_at IS NULL
    ORDER BY created_at ASC
    LIMIT 100
  `;

  for (const event of events) {
    const route = await db.notifications.eventRouting.findUnique({
      where: { sourceContext_eventType: { sourceContext: schemaName, eventType: event.eventType } },
    });
    if (!route) {
      logger.warn("unrouted_domain_event", { schemaName, eventType: event.eventType });
      continue; // flagged by CI lint separately; do not fail the whole batch
    }

    const userId = event.payload.userId;
    const prefs = await getOrDefaultPreferences(userId, route.notificationType, route.consentClass);

    const notif = await db.notifications.notifications.create({
      data: {
        id: ulid(),
        userId,
        notificationType: route.notificationType,
        sourceContext: schemaName,
        sourceEventId: event.id,
        payload: event.payload,
        channelSent: prefs.inAppEnabled ? ["in_app"] : [],
      },
    });

    if (prefs.emailEnabled) {
      if (prefs.digestFrequency === "realtime") {
        await graphileWorker.addJob("sendNotificationEmail", { notificationId: notif.id });
      } else {
        await db.notifications.notifications.update({
          where: { id: notif.id },
          data: { channelSent: { push: "digest_queued" } },
        });
      }
    }

    await db.$executeRaw`UPDATE ${schemaName}.domain_events SET processed_at = now() WHERE id = ${event.id}`;
  }
}
```

**Resend send (React Email template)**
```ts
import { Resend } from "resend";
import { HourApprovedEmail } from "@/emails/hour-approved";

const resend = new Resend(env.RESEND_API_KEY);

export async function sendNotificationEmail(notificationId: string) {
  const notif = await db.notifications.notifications.findUniqueOrThrow({ where: { id: notificationId } });
  const user = await getUserContactInfo(notif.userId);

  await resend.emails.send({
    from: "Agentics Volunteer Portal <notifications@mail.volunteer.agentics.org>",
    to: user.email,
    subject: renderSubject(notif.notificationType, notif.payload),
    react: <HourApprovedEmail {...notif.payload} unsubscribeUrl={buildUnsubscribeUrl(user.id, notif.notificationType)} />,
    headers: { "List-Unsubscribe": `<${buildUnsubscribeUrl(user.id, notif.notificationType)}>` },
  });

  await db.notifications.notifications.update({
    where: { id: notificationId },
    data: { channelSent: { push: "email" } },
  });
}
```

**Digest job**: `sendDigestEmails` runs hourly, groups `notifications.notifications` rows where `channel_sent` contains `digest_queued` and the user's local digest-send time has arrived, renders a single digest email per user, marks them `digest_sent`.

**Resend webhooks**: `POST /api/webhooks/resend` handles `email.bounced` / `email.complained` events, auto-setting `email_enabled = false` for that user across all types on hard bounce/complaint, logged to `notifications.delivery_events` for deliverability monitoring.

**Config/secrets**: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, sending domain DNS records (SPF/DKIM/DMARC) provisioned via Terraform against the Resend domain API where supported.
