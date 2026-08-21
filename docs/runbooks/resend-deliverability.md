# Runbook: Check Resend deliverability status

**Symptom this addresses**: reports that transactional email (hour-approval
notices, DSAR export ready, etc.) isn't arriving, or ADR-0013's dashboard-only
"email deliverability (bounce/complaint rate trend)" signal looks elevated.

## Background

`notifications.delivery_attempt` (`apps/web/prisma/schema.prisma`) records one row per
send attempt, with `status` moving `pending -> sent -> bounced` and
`provider_message_id` holding Resend's own message id for correlation.
`handleResendWebhook` (`apps/web/src/modules/notifications/application/handleResendWebhook.ts`)
is the code that would transition `sent -> bounced` on a `email.bounced` /
`email.complained` Resend webhook event, matched by `provider_message_id`.

**Honesty note**: as of this stage, `handleResendWebhook` exists and is unit-tested,
but the actual HTTP route that would receive Resend's webhook
(`app/api/webhooks/resend/route.ts`, referenced by
`apps/web/src/modules/notifications/application/handleResendWebhook.ts`'s own doc
comment as "a later stage") has **not been built yet**, and no `RESEND_WEBHOOK_SECRET` /
live Resend account exists in this environment. This means: in the current codebase,
`delivery_attempt.status` will only ever reach `bounced` if `handleResendWebhook` is
invoked directly (e.g. from a future route, or manually per Step 3 below) — there is no
live webhook subscription actually updating it yet. Everything below is written to be
accurate against what exists today; the "check via the webhook pipeline" angle
describes intended, not yet fully wired, behavior.

## Step 1: Check delivery status directly in Postgres

```sql
-- Recent attempts and their outcome, most recent first.
SELECT da.id, da.notification_id, da.channel, da.status, da.provider_message_id,
       da.attempted_at, da.retry_count, da.error_message, n.type AS notification_type,
       n.recipient_person_id
  FROM "notifications".delivery_attempt da
  JOIN "notifications".notification n ON n.id = da.notification_id
 WHERE da.channel = 'email'
 ORDER BY da.created_at DESC
 LIMIT 50;
```

```sql
-- Bounce/complaint rate over a trailing window (ADR-0013's dashboard-only signal).
SELECT status, count(*) AS n
  FROM "notifications".delivery_attempt
 WHERE channel = 'email' AND created_at > now() - interval '24 hours'
 GROUP BY status;
```

A specific recipient's non-delivery:

```sql
SELECT da.*
  FROM "notifications".delivery_attempt da
  JOIN "notifications".notification n ON n.id = da.notification_id
 WHERE n.recipient_person_id = '<person id>'
 ORDER BY da.created_at DESC;
```

## Step 2: Check Resend's own dashboard/API directly

If a `RESEND_API_KEY` is configured for the environment in question, Resend's own
dashboard (`https://resend.com/emails`) or its API
(`GET https://api.resend.com/emails/{id}`, using `delivery_attempt.provider_message_id`
as `{id}`) is the authoritative source for what actually happened to a specific send —
bounce reason, complaint detail, spam-report status — beyond the coarse `bounced`
status this app's own DB tracks. This is the step to reach for when the DB shows
`status = 'sent'` but the recipient still says they never received it (the send
succeeded from this app's point of view; the failure, if any, is downstream of Resend
accepting it).

## Step 3: If `handleResendWebhook`'s status transition needs to be applied manually

Given the route isn't wired yet (see the honesty note above), a bounce Resend reports
via its dashboard/API won't automatically reach `delivery_attempt.status` today. Two
options:

**Preferred — call the real use case function** (preserves its exact logic: the
`sent`-only guard, `NotificationFailed` event emission) from a one-off script or REPL
against the environment's `DATABASE_URL`:

```ts
import { handleResendWebhook } from "@/modules/notifications/application/handleResendWebhook";
// prisma: a real PrismaClient for the target environment.
await handleResendWebhook(prisma, {
  type: "email.bounced",
  providerMessageId: "<Resend's message id from Step 2>",
});
```

**Manual SQL fallback** — only if the above isn't practical, and note this skips the
`NotificationFailed` domain-event emission `handleResendWebhook` would otherwise do
(follow up separately if a consumer needs to see that event):

```sql
UPDATE "notifications".delivery_attempt
   SET status = 'bounced', error_message = 'email.bounced'
 WHERE provider_message_id = '<Resend message id>' AND status = 'sent';
```

## Step 4: Diagnose a systemic (not single-recipient) deliverability problem

- **Every recent attempt shows `status = 'pending'` and never advances** — the sending
  path itself (`resendAdapter.sendTransactionalEmail`,
  `apps/web/src/modules/notifications/infra/resendClient.ts`) is likely failing before
  it even reaches Resend, most commonly `RESEND_API_KEY` unset — that call throws
  `ExternalServiceNotConfiguredError` naming the exact missing var (never fakes a
  send). Check the worker/app's structured logs for that error.
- **A specific domain (e.g. one email provider) is bouncing disproportionately** —
  cross-reference `error_message` values across affected rows; this is usually a
  sending-domain reputation or DNS (SPF/DKIM/DMARC on
  `mail.volunteer.agentics.org`, ADR-0012's sending identity) issue on Resend's/DNS
  side, not an application bug — check Resend's domain-verification status in its
  dashboard.
- **Elevated complaint rate** — per ADR-0013, this is dashboard-only (not page/ticket
  worthy on its own) but worth investigating the `List-Unsubscribe` headers
  (`buildSendRequestBody` in `resendClient.ts`) are actually present and honored.
