import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resendAdapter, ExternalServiceNotConfiguredError, type ResendWebhookHeaders } from "@/modules/notifications";

const ENV_KEYS = ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"] as const;

// This environment has no live Resend credentials (per this phase's own
// brief). Every test here either proves the adapter throws
// `ExternalServiceNotConfiguredError` (never fakes a successful send, never
// makes a live network call) when the relevant env var is absent, or
// exercises the request-shape/signing logic through the adapter's own
// public methods (setting the env var, no network call) — same precedent
// as `tests/unit/cloudflareStreamClient.test.ts`.
describe("resendAdapter", () => {
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
    vi.restoreAllMocks();
  });

  describe("throws ExternalServiceNotConfiguredError when unconfigured, with no live network call", () => {
    it("sendTransactionalEmail throws naming RESEND_API_KEY and never calls fetch", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(
        resendAdapter.sendTransactionalEmail({ to: "person@example.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" }),
      ).rejects.toBeInstanceOf(ExternalServiceNotConfiguredError);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("names the exact missing env var", async () => {
      await expect(
        resendAdapter.sendTransactionalEmail({ to: "person@example.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" }),
      ).rejects.toThrow(/RESEND_API_KEY/);
    });

    it("verifyWebhookSignature throws naming RESEND_WEBHOOK_SECRET, without needing a body/signature to even look valid", () => {
      const headers: ResendWebhookHeaders = { svixId: "id", svixTimestamp: "1", svixSignature: "v1,abc" };
      expect(() => resendAdapter.verifyWebhookSignature("{}", headers)).toThrow(ExternalServiceNotConfiguredError);
      expect(() => resendAdapter.verifyWebhookSignature("{}", headers)).toThrow(/RESEND_WEBHOOK_SECRET/);
    });
  });

  describe("sendTransactionalEmail's real request-shape logic, once configured (mocked fetch, no live network call)", () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = "test-api-key";
    });

    it("POSTs the expected Resend send-email request body and returns the provider message id", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id: "msg_abc123" }), { status: 200 }),
      );

      const result = await resendAdapter.sendTransactionalEmail({
        to: "person@example.test",
        subject: "Your hours were approved",
        html: "<p>Nice work</p>",
        text: "Nice work",
      });

      expect(result).toEqual({ providerMessageId: "msg_abc123" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe("https://api.resend.com/emails");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        to: ["person@example.test"],
        subject: "Your hours were approved",
        html: "<p>Nice work</p>",
        text: "Nice work",
      });
      expect(typeof body.from).toBe("string");
      expect(body.from).toMatch(/@/);
    });

    it("throws (not a synthetic success) when Resend rejects the request", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad request", { status: 422 }));

      await expect(
        resendAdapter.sendTransactionalEmail({ to: "person@example.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" }),
      ).rejects.toThrow(/422/);
    });
  });

  describe("verifyWebhookSignature (real HMAC-SHA256, no network)", () => {
    const secret = "whsec_dGVzdC1zaWduaW5nLXNlY3JldA=="; // whsec_ + base64("test-signing-secret")

    beforeEach(() => {
      process.env.RESEND_WEBHOOK_SECRET = secret;
    });

    function sign(id: string, timestamp: string, body: string): string {
      const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
      const signedContent = `${id}.${timestamp}.${body}`;
      return createHmac("sha256", secretBytes).update(signedContent).digest("base64");
    }

    it("accepts a correctly signed payload", () => {
      const body = JSON.stringify({ type: "email.bounced", data: { email_id: "msg_1" } });
      const headers: ResendWebhookHeaders = {
        svixId: "msg_id_1",
        svixTimestamp: "1700000000",
        svixSignature: `v1,${sign("msg_id_1", "1700000000", body)}`,
      };
      expect(resendAdapter.verifyWebhookSignature(body, headers)).toBe(true);
    });

    it("rejects a tampered body", () => {
      const originalBody = JSON.stringify({ type: "email.bounced", data: { email_id: "msg_1" } });
      const headers: ResendWebhookHeaders = {
        svixId: "msg_id_1",
        svixTimestamp: "1700000000",
        svixSignature: `v1,${sign("msg_id_1", "1700000000", originalBody)}`,
      };
      const tamperedBody = JSON.stringify({ type: "email.bounced", data: { email_id: "attacker-controlled" } });
      expect(resendAdapter.verifyWebhookSignature(tamperedBody, headers)).toBe(false);
    });

    it("rejects a signature computed with the wrong secret", () => {
      const body = JSON.stringify({ type: "email.bounced" });
      const wrongSecretBytes = Buffer.from("d3Jvbmctc2VjcmV0", "base64");
      const badSig = createHmac("sha256", wrongSecretBytes).update(`msg_id_1.1700000000.${body}`).digest("base64");
      const headers: ResendWebhookHeaders = { svixId: "msg_id_1", svixTimestamp: "1700000000", svixSignature: `v1,${badSig}` };
      expect(resendAdapter.verifyWebhookSignature(body, headers)).toBe(false);
    });

    it("rejects missing headers", () => {
      const headers: ResendWebhookHeaders = { svixId: null, svixTimestamp: null, svixSignature: null };
      expect(resendAdapter.verifyWebhookSignature("{}", headers)).toBe(false);
    });

    it("accepts a valid signature among multiple space-separated candidates (secret-rotation support)", () => {
      const body = JSON.stringify({ type: "email.complained" });
      const goodSig = sign("msg_id_2", "1700000001", body);
      const headers: ResendWebhookHeaders = {
        svixId: "msg_id_2",
        svixTimestamp: "1700000001",
        svixSignature: `v1,not-the-right-signature v1,${goodSig}`,
      };
      expect(resendAdapter.verifyWebhookSignature(body, headers)).toBe(true);
    });
  });
});
