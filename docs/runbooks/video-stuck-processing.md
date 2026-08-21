# Runbook: Manually mark a video ready/failed when the Cloudflare webhook is lost

**Symptom this addresses**: a training video's `encodeStatus` is stuck at
`processing` (or even `uploading`) well past Cloudflare's normal encode time, because
the `POST /api/v1/webhooks/cloudflare-stream` delivery never arrived, arrived and
failed signature verification, or arrived while `CLOUDFLARE_STREAM_WEBHOOK_SECRET`
was misconfigured.

## Background

`training.video.encode_status` (`apps/web/prisma/schema.prisma`'s `Video` model) is a
`TrainingEncodeStatus` moving `uploading -> processing -> ready | error`. The only
normal path to `ready` is the webhook handler,
`ingestVideoWebhook` (`apps/web/src/modules/training/application/ingestVideoWebhook.ts`),
called from `POST /api/v1/webhooks/cloudflare-stream`
(`apps/web/src/app/api/v1/webhooks/cloudflare-stream/route.ts`). Cloudflare retries on
any non-2xx response, so a *temporary* outage on this app's side usually self-heals —
this runbook is for when the webhook is genuinely lost (Cloudflare-side delivery
failure, a secret rotation mismatch that's since been fixed but the original
delivery's retries were exhausted, etc.) and Cloudflare will not redeliver it.

## Step 1: Confirm the video's actual encode state with Cloudflare directly

Don't guess from app state alone — query Cloudflare's Stream API for the real state
(requires `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_STREAM_API_TOKEN`, the same two env
vars `apps/web/src/modules/training/infra/cloudflareStreamClient.ts`'s
`createDirectUploadUrl`/`requestAutoCaptions` use — if these aren't configured in this
environment, this step can't be done and you should treat Cloudflare's dashboard UI as
the source of truth instead):

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream/${STREAM_UID}" \
  -H "Authorization: Bearer ${CLOUDFLARE_STREAM_API_TOKEN}" | jq '.result | {status, duration, readyToStream}'
```

Find `STREAM_UID` (Cloudflare's `uid`) from the stuck row:

```sql
SELECT v.id, v.cloudflare_stream_id, v.encode_status, v.caption_status, v.duration_seconds
  FROM "training".video v
 WHERE v.encode_status IN ('uploading', 'processing')
 ORDER BY v.created_at
 LIMIT 20;
```

## Step 2: If Cloudflare confirms the video is ready

Prefer **replaying the webhook** over hand-writing the DB state, so the real handler's
full logic runs (event emission, auto-caption request) exactly as if the webhook had
arrived normally — this is far safer than a manual `UPDATE`, which would silently skip
the `VideoEncodeCompleted` domain event and the auto-caption kickoff. Build a payload
matching `CloudflareStreamWebhookPayload`
(`apps/web/src/modules/training/application/ingestVideoWebhook.ts`) from what
Cloudflare's API returned in Step 1, and re-POST it, signed correctly:

```bash
# Requires CLOUDFLARE_STREAM_WEBHOOK_SECRET (or ask whoever holds it to run this).
# Cloudflare's own signature scheme (parseWebhookSignatureHeader in
# cloudflareStreamClient.ts): "time=<unix_seconds>,sig1=<hex_hmac_sha256_of_time.body>"
BODY='{"uid":"<STREAM_UID>","status":{"state":"ready"},"duration":<seconds>,"readyToStream":true}'
TIME=$(date +%s)
SIG=$(printf '%s.%s' "$TIME" "$BODY" | openssl dgst -sha256 -hmac "$CLOUDFLARE_STREAM_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST "https://<deployment-host>/api/v1/webhooks/cloudflare-stream" \
  -H "webhook-signature: time=${TIME},sig1=${SIG}" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

This is safe to run even if some earlier partial delivery did land: `ingestVideoWebhook`
is idempotent on `cloudflare_stream_id` (its own doc comment: "Idempotency: keyed on
`cf_stream_uid` ... an unknown `uid`, or a redelivery of a state the row already
reflects, is a silent no-op, never an error") and re-checks `video.encodeStatus ===
"ready"` before doing anything, so a duplicate replay of an already-applied `ready`
state is a guaranteed no-op.

## Step 3: If direct webhook replay isn't practical (no access to the signing secret, etc.) — manual DB update as a last resort

This skips `VideoEncodeCompleted` event emission and the auto-caption kickoff — do
this only when Step 2 genuinely isn't available, and manually follow up on both:

```sql
BEGIN;

UPDATE "training".video
   SET encode_status = 'ready', duration_seconds = <seconds from Cloudflare>
 WHERE id = '<video id>' AND encode_status != 'ready';

-- Manually emit the domain event the real handler would have (so any consumer
-- watching for VideoEncodeCompleted still sees it) — ULID generation matches
-- @volunteer-portal/ulid's format; substitute a real one.
INSERT INTO "training".domain_events (id, aggregate_type, aggregate_id, event_type, payload)
VALUES (
  '<new ULID>', 'Video', '<video id>', 'VideoEncodeCompleted',
  jsonb_build_object('videoId', '<video id>', 'durationSeconds', <seconds>, 'encodeStatus', 'ready')
);

COMMIT;
```

Then separately trigger auto-captions if desired (`requestAutoCaptions` in
`cloudflareStreamClient.ts` — this is a live Cloudflare API call, not a DB write, so it
must be run from application code or `curl` against Cloudflare directly, not SQL), and
update `caption_status` accordingly once it completes.

## Step 4: If Cloudflare confirms the encode genuinely failed

Mark it `error` (the terminal failure state — `ingestVideoWebhook`'s own comment:
"`error` is terminal (same as `ready`)"):

```sql
UPDATE "training".video
   SET encode_status = 'error'
 WHERE id = '<video id>' AND encode_status != 'ready';
```

No domain event is emitted for the `error` transition in the current handler (only the
`ready` transition emits `VideoEncodeCompleted`), so no manual event insert is needed
here — this matches `ingestVideoWebhook`'s own behavior for a `status.state === "error"`
delivery. Communicate to the content owner that the source upload needs to be
re-submitted.

## Step 5: Prevent recurrence

If the root cause was a webhook signature/secret mismatch, verify
`CLOUDFLARE_STREAM_WEBHOOK_SECRET` matches what's configured on the Cloudflare Stream
webhook subscription itself (Cloudflare dashboard, or `stream/webhook` API endpoint) —
a mismatch here causes every delivery to 401 and get silently exhausted by Cloudflare's
retry policy, not just this one video.
