# ADR-0010: Video Hosting on Cloudflare Stream with Signed Playback and Mandatory Human-Reviewed Captions

## Status
Accepted — 2026-08-10

## Context
The training-video library is a primary product surface: chapters run onboarding, safety, and role-specific training through it, and completion feeds gamification (badges) and compliance records (who has completed what, and when). This creates two forces that a generic "just embed a video" approach cannot satisfy:

1. **Access control that means something.** Some training content is chapter-restricted, role-restricted, or gated behind prerequisite modules. A player embed that resolves to a public or unlisted URL cannot enforce "only enrolled volunteers with an active chapter membership may play this," and any link that leaks defeats the control entirely.
2. **Accessibility as a publish gate, not a nice-to-have.** Research (`docs/research/03-training-video-lms.md` §4, `05-domain-and-compliance.md` §3) establishes that WCAG 2.1 AA (via 1.2.2/1.2.4) requires synchronized, speaker-identified, non-speech-aware captions, and that **raw auto-generated captions do not meet this bar** — they require human review/correction before the video is fit to publish. The domain-compliance day-one checklist is explicit: "captions required before a training video publishes" is a CI/process gate, not a suggestion.

The research document's own recommendation (`03-training-video-lms.md`, "Recommendation: Embed-first, upgrade later") proposes starting with unlisted YouTube embeds for a **volunteer-run, near-zero-budget MVP**, and revisiting managed streaming "once the org needs access control, richer analytics, or hits YouTube's practical ceiling." That framing was correct for the cost-constrained scenario it analyzed. This ADR set, however, targets a production-grade, commercially operated platform for Agentics Foundation from the outset — chapter-scoped access control and first-party analytics are not deferred nice-to-haves here, they are day-one requirements. We therefore make the "later" call now.

This decision must also compose with the canonical architecture: video state changes flow through the transactional outbox (`domain_events` in the `training` schema) drained by graphile-worker, storage of non-video assets (certificates, exports) is Cloudflare R2 (ADR-0011), and background jobs already run on graphile-worker.

## Decision
**Cloudflare Stream is the sole video hosting, transcoding, and delivery platform for all training video content.**

- **Ingestion**: Content authors upload source video via Cloudflare Stream's direct creator upload API (TUS-resumable). The `training.videos` table stores a `cf_stream_uid`, `status` (`uploading | processing | ready | failed`), and `caption_status` (`none | auto_draft | in_review | approved`).
- **Encode pipeline**: Cloudflare Stream transcodes to adaptive-bitrate HLS/DASH automatically. A webhook receiver (`POST /api/webhooks/cloudflare-stream`) verifies the Stream webhook signature and, on `video.ready` (or equivalent ready-state notification), writes a row to `training.domain_events` (`VideoEncodeCompleted`) inside the same transaction that flips `videos.status` to `ready`. graphile-worker drains that event to (a) notify the content author their video is ready to caption/publish, and (b) kick off the auto-caption draft job.
- **Access control**: Playback never uses Cloudflare's public/default UIDs directly. Every playback request goes through a tRPC/REST endpoint that runs the `can(subject, "video:play", video)` policy check (chapter scope, enrollment, prerequisite completion) and, only on success, mints a **signed Stream URL** using a Stream signing key, with a short TTL (default 4 hours, configurable per content sensitivity) and viewer-bound claims (`sub`, `exp`, optionally `downloadable: false`). No long-lived or shareable playback URLs are ever persisted or emailed.
- **Captioning workflow (publish gate)**:
  1. On encode-complete, Cloudflare Stream's automatic captions (or a dedicated ASR pass) generate a draft `.vtt` track → `caption_status = auto_draft`.
  2. A human reviewer (content author or designated captioner role) edits the draft in an in-app caption editor (timestamp-synced text correction) → `caption_status = in_review` while editing, `caption_status = approved` on submit.
  3. The **publish action is hard-gated**: `training.videos.publish()` throws/rejects unless `caption_status = 'approved'`. There is no override flag in production. This directly encodes the compliance-research finding that raw auto-captions are non-compliant.
  4. Approved captions are uploaded to Cloudflare Stream as a real WebVTT caption track (toggleable/searchable), never burned in, per the research's explicit recommendation against burned-in captions.
- **Analytics/ownership**: Cloudflare Stream's viewer analytics (watch time, drop-off, completion) are ingested via the Stream API into `training` schema tables for progress-tracking and reporting; this is first-party data the org owns outright, feeding grant reports and completion dashboards.
- **Cost model accepted**: $1/1,000 minutes stored + $5/1,000 minutes delivered, no separate bandwidth line item — budgeted as a fixed line item against the training library size, not treated as a blocker at commercial scale.

**Rejected for production: unlisted YouTube embeds.** The research correctly identifies unlisted YouTube as viable for a zero-budget MVP, but it fails every hard requirement of a commercial platform:
- **No real access control** — an unlisted link is shareable outside the org by design; there is no way to bind playback to chapter/role/enrollment state.
- **No first-party viewer data** — watch analytics live in YouTube's ecosystem, not ours, undermining grant reporting and progress tracking that must be queryable in our own schema.
- **Branding/ads exposure** — a nonprofit training platform showing YouTube chrome (and potential ads/recommended-video rabbit holes) is not commercial-grade UX.
- **Caption compliance risk** — nothing stops a content author from shipping raw YouTube auto-captions since YouTube has no publish gate; our own gate is the only reliable enforcement point.

YouTube embeds are noted here purely as the rejected phase-0 alternative from earlier research, not as a fallback for this build.

## Consequences

### Positive
- Real, enforceable, per-request access control tied to the existing RBAC policy module (`can()`), consistent with how every other protected resource in the platform is authorized.
- Compliance-by-construction: it is structurally impossible to publish a video without an approved, human-corrected caption track.
- First-party analytics and viewer data, owned by the org, queryable for grant/impact reporting without a third-party data-sharing dependency.
- Encode pipeline integrates cleanly with the outbox/graphile-worker pattern already used everywhere else — no bespoke polling or cron job for "is my video ready yet."
- No branding/ads leakage; the player is fully white-labeled inside the portal.

### Negative / Trade-offs
- Real, metered cost that scales with library size and viewership (storage + delivery minutes) — unlike YouTube's free tier, this is an ongoing budget line the org must plan for (worth pursuing Cloudflare's nonprofit/startup pricing outreach per the research note).
- Requires building and maintaining a caption-review UI (timestamp-synced editor) rather than relying on an off-the-shelf captioning surface — real engineering effort, not a checkbox integration.
- Webhook receiver and signed-URL minting are new attack surface requiring careful signature verification and key rotation discipline (Stream signing keys, webhook secret).
- Short-lived signed URLs mean the player must handle URL refresh/re-auth on long-running sessions (e.g., a paused video resumed after the TTL expires) — added client-side complexity.
- No built-in creator-facing community features (comments, likes) that a YouTube embed would have gotten for free — acceptable since community interaction lives in the platform's own `community` schema instead.

## Alternatives Considered
- **Unlisted YouTube embed (the research's MVP recommendation)** — rejected for production as detailed above: no enforceable access control, no first-party analytics, ads/branding exposure, no reliable caption-compliance gate. Retained conceptually only as the "phase 0, near-zero-budget" alternative that this ADR deliberately supersedes.
- **Mux** — a close technical peer to Cloudflare Stream (research: ~$52/mo vs. Cloudflare's ~$75/mo at a 50,000-delivered-minute/month reference workload) with a generous free delivery tier. Rejected primarily for platform cohesion: the canonical stack already commits to Cloudflare for object storage (R2) and CDN/edge (per the technical-architecture research), so consolidating video onto the same vendor reduces the number of signed-URL/webhook/billing integrations, sub-processor entries (relevant to the GDPR processor inventory), and vendor relationships a small team must operate. Mux remains a reasonable fallback if Cloudflare Stream pricing or reliability becomes a blocker post-launch.
- **Self-hosted (PeerTube)** — rejected per the research's own conclusion: full sysadmin burden (transcoding, storage scaling, security patching, HLS/WebTorrent operations) is not sustainable for a small team operating a commercial-grade platform, and the marginal cost savings do not offset the ops risk. Reserved only for a future "data sovereignty becomes a hard requirement" scenario, which is not the case here.
- **Vimeo** — rejected: bandwidth-capped tiers (2TB) are a poor fit for an unpredictable, growing training library, and its API/webhook integration surface for building a custom signed-access LMS layer is weaker than Cloudflare Stream's or Mux's purpose-built developer APIs.

## Implementation Notes

**Schema (`training` schema, illustrative)**
```sql
CREATE TABLE training.videos (
  id              TEXT PRIMARY KEY,               -- ULID
  module_id       TEXT NOT NULL REFERENCES training.modules(id),
  cf_stream_uid   TEXT UNIQUE,                     -- Cloudflare Stream video UID
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'uploading'
                    CHECK (status IN ('uploading','processing','ready','failed')),
  caption_status  TEXT NOT NULL DEFAULT 'none'
                    CHECK (caption_status IN ('none','auto_draft','in_review','approved')),
  caption_vtt_key TEXT,                            -- R2 key or CF caption track ref for the approved track
  duration_seconds INTEGER,
  published_at    TIMESTAMPTZ,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE training.domain_events (
  id           TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  event_type   TEXT NOT NULL,        -- 'VideoEncodeCompleted', 'VideoCaptionsApproved', 'VideoPublished'
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
```

**Publish gate (application-layer invariant, not just UI validation)**
```ts
async function publishVideo(videoId: string) {
  const video = await db.training.videos.findUniqueOrThrow({ where: { id: videoId } });
  if (video.captionStatus !== "approved") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Cannot publish: captions must be human-reviewed and approved first.",
    });
  }
  // ... set published_at, emit VideoPublished domain event in same transaction
}
```

**Signed playback URL minting**
```ts
// Verifies enrollment/RBAC via can(), then mints a short-lived Stream signed URL.
async function getPlaybackUrl(subject: Subject, videoId: string) {
  const video = await requireVideo(videoId);
  await assertCan(subject, "video:play", video);   // scoped RBAC policy check

  const token = await signStreamToken({
    videoUid: video.cfStreamUid,
    keyId: env.CF_STREAM_SIGNING_KEY_ID,
    privateKey: env.CF_STREAM_SIGNING_KEY,          // stored in secrets manager, rotated quarterly
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 4, // 4h TTL
    sub: subject.userId,
    downloadable: false,
  });

  return `https://customer-${env.CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/manifest/video.m3u8`;
}
```

**Webhook receiver**
- Route: `POST /api/webhooks/cloudflare-stream`.
- Verifies `Webhook-Signature` header against `CF_STREAM_WEBHOOK_SECRET` (HMAC) before processing.
- On `readyToStream: true`: within one DB transaction, set `videos.status = 'ready'`, insert `VideoEncodeCompleted` into `training.domain_events`, commit. graphile-worker job `notifyAuthorVideoReady` and `generateCaptionDraft` are enqueued off that event (see ADR-0012 for the notification leg).
- Idempotency: keyed on `cf_stream_uid` + event type; duplicate webhook deliveries (Cloudflare retries on non-2xx) are no-ops if `status` is already `ready`.

**Caption editor**
- Draft `.vtt` pulled from Cloudflare Stream's auto-caption output, rendered as a timestamp-synced editable transcript (reuse an existing open-source WebVTT editor component rather than building one from scratch).
- Reviewer submit action: uploads corrected `.vtt` to Cloudflare Stream captions endpoint, sets `caption_status = 'approved'`, `caption_vtt_key` recorded, emits `VideoCaptionsApproved` domain event (drives a notification to the content-approval workflow if module publishing requires a second sign-off).

**Config/secrets**: `CF_STREAM_ACCOUNT_ID`, `CF_STREAM_API_TOKEN` (upload/webhook management), `CF_STREAM_SIGNING_KEY_ID` + `CF_STREAM_SIGNING_KEY` (playback signing, distinct from the API token, least-privilege), `CF_STREAM_WEBHOOK_SECRET`, `CF_STREAM_CUSTOMER_CODE`. All stored in the platform secrets manager (Vercel encrypted env vars), never in source.

**Monitoring**: Stream webhook failures and stuck `processing` videos (>30 min) alert via Sentry (ADR-0013); a graphile-worker scheduled job sweeps for stale `processing` rows and flags them for manual review.
