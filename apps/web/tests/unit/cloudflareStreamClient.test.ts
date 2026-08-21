import { generateKeyPairSync, createHmac, createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudflareStreamAdapter, ExternalServiceNotConfiguredError } from "@/modules/training";

const ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_STREAM_API_TOKEN",
  "CLOUDFLARE_STREAM_WEBHOOK_SECRET",
  "CLOUDFLARE_STREAM_SIGNING_KEY_ID",
  "CLOUDFLARE_STREAM_SIGNING_KEY",
  "CLOUDFLARE_STREAM_CUSTOMER_CODE",
] as const;

// This environment has no live Cloudflare Stream credentials (per this
// phase's own brief). Every test here either proves the adapter throws
// `ExternalServiceNotConfiguredError` (never fakes success) when the
// relevant env var is absent, or exercises the request-shape/signing logic
// in isolation — no live network call, no real Cloudflare account.
describe("cloudflareStreamAdapter", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  describe("throws ExternalServiceNotConfiguredError when unconfigured", () => {
    it("createDirectUploadUrl", async () => {
      await expect(cloudflareStreamAdapter.createDirectUploadUrl()).rejects.toBeInstanceOf(
        ExternalServiceNotConfiguredError,
      );
    });

    it("requestAutoCaptions", async () => {
      await expect(cloudflareStreamAdapter.requestAutoCaptions("uid_1")).rejects.toBeInstanceOf(
        ExternalServiceNotConfiguredError,
      );
    });

    it("verifyWebhookSignature", () => {
      expect(() => cloudflareStreamAdapter.verifyWebhookSignature("{}", "time=1,sig1=abc")).toThrow(
        ExternalServiceNotConfiguredError,
      );
    });

    it("mintSignedPlaybackUrl", async () => {
      await expect(cloudflareStreamAdapter.mintSignedPlaybackUrl("uid_1", "viewer_1")).rejects.toBeInstanceOf(
        ExternalServiceNotConfiguredError,
      );
    });

    it("names the exact missing env var", async () => {
      await expect(cloudflareStreamAdapter.createDirectUploadUrl()).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    });
  });

  describe("verifyWebhookSignature (real HMAC-SHA256, no network)", () => {
    beforeEach(() => {
      process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET = "test-webhook-secret";
    });

    function sign(time: string, body: string, secret = "test-webhook-secret"): string {
      return createHmac("sha256", secret).update(`${time}.${body}`).digest("hex");
    }

    it("accepts a correctly signed payload", () => {
      const body = JSON.stringify({ uid: "abc123", readyToStream: true });
      const time = "1700000000";
      const header = `time=${time},sig1=${sign(time, body)}`;
      expect(cloudflareStreamAdapter.verifyWebhookSignature(body, header)).toBe(true);
    });

    it("rejects a tampered body", () => {
      const time = "1700000000";
      const header = `time=${time},sig1=${sign(time, JSON.stringify({ uid: "abc123" }))}`;
      const tamperedBody = JSON.stringify({ uid: "attacker-controlled" });
      expect(cloudflareStreamAdapter.verifyWebhookSignature(tamperedBody, header)).toBe(false);
    });

    it("rejects a signature computed with the wrong secret", () => {
      const body = JSON.stringify({ uid: "abc123" });
      const time = "1700000000";
      const header = `time=${time},sig1=${sign(time, body, "wrong-secret")}`;
      expect(cloudflareStreamAdapter.verifyWebhookSignature(body, header)).toBe(false);
    });

    it("rejects a missing header", () => {
      expect(cloudflareStreamAdapter.verifyWebhookSignature("{}", null)).toBe(false);
    });

    it("rejects a malformed header", () => {
      expect(cloudflareStreamAdapter.verifyWebhookSignature("{}", "not-a-valid-header")).toBe(false);
    });
  });

  describe("mintSignedPlaybackUrl (real RS256 JWT signing, no network)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signingKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

    beforeEach(() => {
      process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID = "test-key-id";
      process.env.CLOUDFLARE_STREAM_SIGNING_KEY = signingKeyPem;
      process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE = "testcustomer";
    });

    it("produces a URL embedding a JWT whose signature verifies against the configured public key", async () => {
      const url = await cloudflareStreamAdapter.mintSignedPlaybackUrl("stream-uid-1", "viewer-42", 3600);
      expect(url).toMatch(/^https:\/\/customer-testcustomer\.cloudflarestream\.com\//);

      const token = url
        .replace("https://customer-testcustomer.cloudflarestream.com/", "")
        .replace("/manifest/video.m3u8", "");
      const [headerB64, payloadB64, signatureB64] = token.split(".");
      const signingInput = `${headerB64}.${payloadB64}`;

      const verifier = createVerify("RSA-SHA256").update(signingInput);
      expect(verifier.verify(publicKey, Buffer.from(signatureB64, "base64url"))).toBe(true);

      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      expect(payload.sub).toBe("stream-uid-1");
      expect(payload.viewerId).toBe("viewer-42");
      expect(payload.downloadable).toBe(false);
      expect(payload.exp - payload.nbf).toBeGreaterThan(3600);
    });

    it("a token signed for one viewer fails verification if the payload is swapped for another viewer", async () => {
      const url = await cloudflareStreamAdapter.mintSignedPlaybackUrl("stream-uid-1", "viewer-42", 3600);
      const token = url.split("/")[3];
      const [headerB64, , signatureB64] = token.split(".");

      const forgedPayload = Buffer.from(JSON.stringify({ sub: "stream-uid-1", viewerId: "attacker" })).toString(
        "base64url",
      );
      const forgedSigningInput = `${headerB64}.${forgedPayload}`;
      const verifier = createVerify("RSA-SHA256").update(forgedSigningInput);
      expect(verifier.verify(publicKey, Buffer.from(signatureB64, "base64url"))).toBe(false);
    });
  });
});
