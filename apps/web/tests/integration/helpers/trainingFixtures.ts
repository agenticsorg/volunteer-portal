import { newId } from "@volunteer-portal/ulid";
import type { CloudflareStreamAdapter, CertificateStorageAdapter } from "@/modules/training";

/**
 * Shared fixtures for the Phase 4 training-use-case integration suites.
 * No live Cloudflare credentials exist in this environment (per this
 * phase's own brief) — every integration test that needs a Cloudflare
 * Stream/R2 adapter injects one of these fakes instead of the real
 * `cloudflareStreamAdapter`/`cloudflareR2Adapter` default, so the domain
 * logic (encode-complete transitions, caption gating, completion,
 * certificate issuance) is exercised end-to-end against a real Postgres
 * without any network call. The *real* adapters' request-shape/signing
 * logic and "throws when unconfigured" behavior are covered separately by
 * unit tests (`tests/unit/cloudflareStreamClient.test.ts`,
 * `tests/unit/cloudflareR2Client.test.ts`).
 */

/** A deterministic fake Cloudflare Stream adapter — always "succeeds," never touches the network. */
export function fakeStreamAdapter(overrides: Partial<CloudflareStreamAdapter> = {}): CloudflareStreamAdapter {
  return {
    async createDirectUploadUrl() {
      const streamUid = newId();
      return { streamUid, uploadUrl: `https://upload.example.test/${streamUid}` };
    },
    async requestAutoCaptions() {
      // no-op: the caller (ingestVideoWebhook) flips captionStatus itself.
    },
    verifyWebhookSignature() {
      return true;
    },
    async mintSignedPlaybackUrl(streamUid, viewerId) {
      return `https://playback.example.test/${streamUid}?viewer=${viewerId}`;
    },
    ...overrides,
  };
}

/** A deterministic fake R2 adapter — always "succeeds," never touches the network. */
export function fakeR2Adapter(overrides: Partial<CertificateStorageAdapter> = {}): CertificateStorageAdapter {
  return {
    async uploadCertificatePdf(key) {
      return { r2Key: key };
    },
    ...overrides,
  };
}

/** Builds a synthetic Cloudflare Stream `readyToStream` webhook body for `ingestVideoWebhook`. */
export function readyWebhookBody(streamUid: string, durationSeconds = 120): string {
  return JSON.stringify({ uid: streamUid, status: { state: "ready" }, duration: durationSeconds, readyToStream: true });
}
