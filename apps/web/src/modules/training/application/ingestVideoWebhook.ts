import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { ExternalServiceNotConfiguredError, WebhookSignatureInvalidError } from "../domain/errors";
import { cloudflareStreamAdapter, type CloudflareStreamAdapter } from "../infra/cloudflareStreamClient";

/**
 * Cloudflare's webhook payload shape (ADR-0010's Integration &
 * Anti-Corruption Notes: `uid`, `status.state`, `duration`,
 * `readyToStream`) — Cloudflare's own vocabulary, translated below into
 * this context's `Video.encodeStatus` vocabulary and never leaked past
 * this handler into the domain model or into events other modules see.
 */
export interface CloudflareStreamWebhookPayload {
  uid: string;
  status?: { state?: string };
  duration?: number;
  readyToStream?: boolean;
}

/**
 * IngestVideoWebhook (docs/ddd/training-learning.md, Key Use Case 3;
 * ADR-0010's Integration & Anti-Corruption Notes). Framework-agnostic by
 * design (takes the raw request body string and the raw
 * `Webhook-Signature` header value, not a `Request` object) so the
 * eventual `POST /api/v1/webhooks/cloudflare-stream` route handler (a
 * later, API-layer stage) is a thin `await req.text()` + header read
 * wrapper over this function, same "use case owns the logic, the route is
 * a thin adapter" split as every tRPC procedure in this codebase.
 *
 * *Pre:* `signatureHeader` verifies against `CLOUDFLARE_STREAM_WEBHOOK_SECRET`
 * (HMAC-SHA256 over `${time}.${rawBody}`).
 *
 * *Post (encode-complete case):* the matching `Video.encodeStatus` is set
 * `'ready'`, `durationSeconds` recorded, `VideoEncodeCompleted` emitted —
 * both in the same transaction. Cloudflare's automatic-caption generation
 * is then requested (ADR-0010: "kick off the auto-caption draft job"; done
 * inline here since no background-job wiring exists yet in this phase,
 * documented simplification) and `captionStatus` moves `pending ->
 * auto_generated` on success.
 *
 * *Idempotency:* keyed on `cf_stream_uid` (ADR-0010's Implementation
 * Notes) — an unknown `uid`, or a redelivery of a state the row already
 * reflects, is a silent no-op, never an error (Cloudflare retries on any
 * non-2xx response).
 */
export interface IngestVideoWebhookInput {
  rawBody: string;
  signatureHeader: string | null;
}

export async function ingestVideoWebhook(
  prisma: PrismaClient,
  input: IngestVideoWebhookInput,
  adapter: CloudflareStreamAdapter = cloudflareStreamAdapter,
): Promise<void> {
  const verified = adapter.verifyWebhookSignature(input.rawBody, input.signatureHeader);
  if (!verified) {
    throw new WebhookSignatureInvalidError();
  }

  const payload = JSON.parse(input.rawBody) as CloudflareStreamWebhookPayload;

  const video = await prisma.video.findUnique({
    where: { cloudflareStreamId: payload.uid },
    select: { id: true, encodeStatus: true, captionStatus: true },
  });
  if (!video) {
    // Unknown stream uid (e.g. a test/replayed webhook against a video
    // never registered here) — idempotent no-op, not an error.
    return;
  }

  const isReady = payload.readyToStream === true || payload.status?.state === "ready";
  if (!isReady) {
    const mapped = payload.status?.state === "error" ? "error" : "processing";
    // `error` is terminal (same as `ready`): once recorded, later webhook
    // redeliveries are no-ops. Otherwise any forward move off the current
    // status is applied — this covers both `uploading -> processing` and a
    // later `processing -> error` delivery (Cloudflare's documented
    // `uploading -> processing -> ready/error` machine), not just the first
    // transition off `uploading`.
    if (video.encodeStatus !== mapped && video.encodeStatus !== "error") {
      await prisma.video.update({ where: { id: video.id }, data: { encodeStatus: mapped } });
    }
    return;
  }

  if (video.encodeStatus === "ready") {
    // Duplicate delivery of an already-processed ready-state — no-op.
    return;
  }

  const durationSeconds = typeof payload.duration === "number" ? Math.round(payload.duration) : null;

  await prisma.$transaction(async (tx) => {
    await tx.video.update({
      where: { id: video.id },
      data: { encodeStatus: "ready", durationSeconds },
    });

    await tx.trainingDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Video",
        aggregateId: video.id,
        eventType: "VideoEncodeCompleted",
        payload: {
          videoId: video.id,
          durationSeconds,
          encodeStatus: "ready",
        } satisfies Prisma.InputJsonValue,
      },
    });
  });

  try {
    await adapter.requestAutoCaptions(payload.uid);
    await prisma.video.update({
      where: { id: video.id, captionStatus: "pending" },
      data: { captionStatus: "auto_generated" },
    });
  } catch (error) {
    // A missing Cloudflare credential must never block the encode-complete
    // state change above (already committed) — leave captionStatus at
    // 'pending' for a human/ops process to retry later. Any other error
    // (a genuine Cloudflare API failure) propagates, since that's not this
    // phase's documented "not configured" simplification.
    if (!(error instanceof ExternalServiceNotConfiguredError)) {
      throw error;
    }
  }
}
