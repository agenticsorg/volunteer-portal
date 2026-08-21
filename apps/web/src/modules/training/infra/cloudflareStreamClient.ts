/**
 * Cloudflare Stream integration (ADR-0010) — the only place in this module
 * that talks to Cloudflare's Stream API or constructs a Stream signed
 * playback token. Every other file in this module depends on the
 * `CloudflareStreamAdapter` *interface* below, never on this file's
 * concrete `fetch` calls directly, so application-layer use cases stay
 * testable without live Cloudflare credentials (inject a fake adapter in
 * tests) and so this is the single, obvious place to swap implementations.
 *
 * This environment has no Cloudflare Stream credentials configured (no
 * `.env` with real values). Every function that would need to make a live
 * network call to Cloudflare, or that would need a real signing secret it
 * doesn't have, throws `ExternalServiceNotConfiguredError` naming the exact
 * missing environment variable — it never fakes success or returns mock
 * data. The request-shape/signing logic itself is real and independently
 * testable (see `tests/unit/cloudflareStreamClient.test.ts`).
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { ExternalServiceNotConfiguredError } from "../domain/errors";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_PLAYBACK_TTL_SECONDS = 4 * 60 * 60; // 4 hours, per ADR-0010

function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ExternalServiceNotConfiguredError(name, purpose);
  }
  return value;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface CloudflareStreamAdapter {
  /**
   * Requests a Cloudflare Stream direct creator upload URL (TUS-resumable) —
   * ADR-0010's Ingestion step. The returned `streamUid` is persisted as
   * `training.video.cloudflare_stream_id` immediately; the returned
   * `uploadUrl` is handed to the client, which uploads the source video
   * bytes directly to Cloudflare (never through this server).
   */
  createDirectUploadUrl(maxDurationSeconds?: number): Promise<{ streamUid: string; uploadUrl: string }>;

  /**
   * Requests Cloudflare Stream's automatic-caption generation for a
   * ready-to-stream video (ADR-0010: "Cloudflare Stream's automatic
   * captions ... generate a draft .vtt track"). The draft this produces is
   * only ever `caption_status = 'auto_generated'` — never sufficient to
   * satisfy the publish gate on its own (ADR-0010/ADR-0014).
   */
  requestAutoCaptions(streamUid: string, language?: string): Promise<void>;

  /**
   * Verifies Cloudflare's `Webhook-Signature` header (HMAC-SHA256 over
   * `${time}.${rawBody}`, per ADR-0010's Implementation Notes) against
   * `CLOUDFLARE_STREAM_WEBHOOK_SECRET`. Pure/synchronous — no network call
   * — but still throws `ExternalServiceNotConfiguredError` if the secret
   * isn't set, since there is no meaningful "verify" without it.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean;

  /**
   * Mints a short-lived, viewer-bound Cloudflare Stream signed playback
   * URL (ADR-0010: "Every playback request ... mints a signed Stream URL
   * using a Stream signing key, with a short TTL"). Pure/synchronous
   * (RS256-signs a JWT locally) — no network call.
   */
  mintSignedPlaybackUrl(streamUid: string, viewerId: string, ttlSeconds?: number): Promise<string>;
}

interface CloudflareApiEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

async function callCloudflareApi<T>(
  path: string,
  apiToken: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const envelope = (await response.json()) as CloudflareApiEnvelope<T>;
  if (!response.ok || !envelope.success) {
    const message = envelope.errors?.map((e) => e.message).join("; ") || response.statusText;
    throw new Error(`Cloudflare Stream API request to "${path}" failed: ${message}`);
  }
  return envelope.result;
}

/**
 * Parses Cloudflare's `Webhook-Signature` header, shaped
 * `time=<unix_seconds>,sig1=<hex_hmac_sha256>` (comma-separated key=value
 * pairs, matching Cloudflare's documented webhook-signing scheme).
 */
function parseWebhookSignatureHeader(header: string): { time: string; sig1: string } | null {
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((pair) => pair.trim().split("=", 2))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  if (!parts.time || !parts.sig1) return null;
  return { time: parts.time, sig1: parts.sig1 };
}

export const cloudflareStreamAdapter: CloudflareStreamAdapter = {
  async createDirectUploadUrl(maxDurationSeconds = 3600) {
    const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", "Creating a Cloudflare Stream direct upload URL");
    const apiToken = requireEnv("CLOUDFLARE_STREAM_API_TOKEN", "Creating a Cloudflare Stream direct upload URL");

    const result = await callCloudflareApi<{ uid: string; uploadURL: string }>(
      `/accounts/${accountId}/stream/direct_upload`,
      apiToken,
      { method: "POST", body: { maxDurationSeconds, requireSignedURLs: true } },
    );
    return { streamUid: result.uid, uploadUrl: result.uploadURL };
  },

  async requestAutoCaptions(streamUid, language = "en") {
    const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", "Requesting Cloudflare Stream auto-captions");
    const apiToken = requireEnv("CLOUDFLARE_STREAM_API_TOKEN", "Requesting Cloudflare Stream auto-captions");

    await callCloudflareApi(`/accounts/${accountId}/stream/${streamUid}/captions/${language}/generate`, apiToken, {
      method: "POST",
    });
  },

  verifyWebhookSignature(rawBody, signatureHeader) {
    const secret = requireEnv(
      "CLOUDFLARE_STREAM_WEBHOOK_SECRET",
      "Verifying a Cloudflare Stream webhook signature",
    );
    if (!signatureHeader) return false;

    const parsed = parseWebhookSignatureHeader(signatureHeader);
    if (!parsed) return false;

    const expectedHex = createHmac("sha256", secret).update(`${parsed.time}.${rawBody}`).digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");
    const actualBuf = Buffer.from(parsed.sig1, "hex");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  },

  async mintSignedPlaybackUrl(streamUid, viewerId, ttlSeconds = DEFAULT_PLAYBACK_TTL_SECONDS) {
    const keyId = requireEnv("CLOUDFLARE_STREAM_SIGNING_KEY_ID", "Minting a Cloudflare Stream signed playback URL");
    const signingKeyPem = requireEnv(
      "CLOUDFLARE_STREAM_SIGNING_KEY",
      "Minting a Cloudflare Stream signed playback URL",
    );
    const customerCode = requireEnv(
      "CLOUDFLARE_STREAM_CUSTOMER_CODE",
      "Minting a Cloudflare Stream signed playback URL",
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: keyId };
    const payload = {
      sub: streamUid,
      kid: keyId,
      exp: nowSeconds + ttlSeconds,
      nbf: nowSeconds - 5,
      // Viewer-bound claim (ADR-0010: "viewer-bound claims (sub, exp,
      // optionally downloadable: false)") — Cloudflare's own token `sub`
      // is the video uid per their API contract, so the authorizing
      // viewer is carried as a custom claim instead.
      viewerId,
      downloadable: false,
    };

    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(signingKeyPem);
    const token = `${signingInput}.${base64url(signature)}`;

    return `https://customer-${customerCode}.cloudflarestream.com/${token}/manifest/video.m3u8`;
  },
};
