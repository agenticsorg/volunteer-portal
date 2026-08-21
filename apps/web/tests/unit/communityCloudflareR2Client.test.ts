import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudflareR2Adapter, presignS3PutUrl, ExternalServiceNotConfiguredError } from "@/modules/community";

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

// This environment has no live Cloudflare R2 credentials (this stage's own
// brief). `cloudflareR2Adapter.createUploadUrl` must throw
// `ExternalServiceNotConfiguredError` naming the exact missing env var
// (never fake success); `presignS3PutUrl`'s AWS SigV4 query-string-signing
// logic is exercised directly and in isolation — no live network call, no
// real R2 bucket. Mirrors tests/unit/cloudflareR2Client.test.ts's own shape
// for training's (header-signing) adapter — this module's adapter signs a
// query-string-presigned PUT URL instead, per infra/cloudflareR2Client.ts's
// own header comment on why it's a distinct, independently-owned adapter.
describe("cloudflareR2Adapter.createUploadUrl", () => {
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

  it("throws ExternalServiceNotConfiguredError naming the exact missing env var", async () => {
    await expect(cloudflareR2Adapter.createUploadUrl("attachments/posts/p1/x.jpg")).rejects.toThrow(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    await expect(cloudflareR2Adapter.createUploadUrl("attachments/posts/p1/x.jpg")).rejects.toBeInstanceOf(
      ExternalServiceNotConfiguredError,
    );
  });

  it("still names the next-missing var once earlier ones are set", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    process.env.R2_BUCKET = "vp-test-attachments";
    await expect(cloudflareR2Adapter.createUploadUrl("attachments/posts/p1/x.jpg")).rejects.toThrow(
      /R2_ACCESS_KEY_ID/,
    );
  });
});

describe("presignS3PutUrl (real AWS SigV4 query-string presign, no network)", () => {
  const baseInput = {
    accountId: "acct123",
    bucket: "vp-test-attachments",
    key: "attachments/posts/person_1/upload_1.jpg",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2026-05-24T00:00:00Z"),
  };

  it("targets the correct R2 endpoint, bucket/key path, and PUT method", () => {
    const signed = presignS3PutUrl(baseInput);
    expect(signed.method).toBe("PUT");
    expect(signed.url).toContain("https://acct123.r2.cloudflarestorage.com/vp-test-attachments/attachments/posts/person_1/upload_1.jpg");
  });

  it("carries the required X-Amz-* query parameters with the right credential scope", () => {
    const signed = presignS3PutUrl(baseInput);
    expect(signed.url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(signed.url).toContain("X-Amz-Credential=AKIDEXAMPLE%2F20260524%2Fauto%2Fs3%2Faws4_request");
    expect(signed.url).toContain("X-Amz-Date=20260524T000000Z");
    expect(signed.url).toContain("X-Amz-Expires=900"); // ADR-0011's documented 15-minute default
    expect(signed.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it("is deterministic: identical inputs produce an identical signature", () => {
    const a = presignS3PutUrl(baseInput);
    const b = presignS3PutUrl(baseInput);
    expect(a.url).toBe(b.url);
  });

  it("changing the key (path) changes the signature", () => {
    const a = presignS3PutUrl(baseInput);
    const b = presignS3PutUrl({ ...baseInput, key: "attachments/posts/person_2/upload_2.jpg" });
    expect(a.url).not.toBe(b.url);
  });

  it("changing the secret key changes the signature", () => {
    const a = presignS3PutUrl(baseInput);
    const b = presignS3PutUrl({ ...baseInput, secretAccessKey: "a-completely-different-secret-key" });
    expect(a.url.split("X-Amz-Signature=")[1]).not.toBe(b.url.split("X-Amz-Signature=")[1]);
  });

  it("respects a custom expiresInSeconds", () => {
    const signed = presignS3PutUrl({ ...baseInput, expiresInSeconds: 60 });
    expect(signed.url).toContain("X-Amz-Expires=60");
  });

  it("URL-encodes path segments in the signed key", () => {
    const signed = presignS3PutUrl({ ...baseInput, key: "attachments/posts/person 1/my photo #1.jpg" });
    expect(signed.url).toContain("attachments/posts/person%201/my%20photo%20%231.jpg");
  });
});
