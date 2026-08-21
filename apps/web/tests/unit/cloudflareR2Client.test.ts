import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudflareR2Adapter, signS3PutRequest, ExternalServiceNotConfiguredError } from "@/modules/training";

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

// This environment has no live Cloudflare R2 credentials. `uploadCertificatePdf`
// must throw `ExternalServiceNotConfiguredError` (never fake success) when
// unconfigured; `signS3PutRequest`'s AWS SigV4 signing logic is exercised
// directly and in isolation — no live network call, no real R2 bucket.
describe("cloudflareR2Adapter.uploadCertificatePdf", () => {
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
    await expect(cloudflareR2Adapter.uploadCertificatePdf("certificates/x/y.pdf", Buffer.from("pdf"))).rejects.toThrow(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    expect(
      cloudflareR2Adapter.uploadCertificatePdf("certificates/x/y.pdf", Buffer.from("pdf")),
    ).rejects.toBeInstanceOf(ExternalServiceNotConfiguredError);
  });
});

describe("signS3PutRequest (real AWS SigV4, no network)", () => {
  const baseInput = {
    accountId: "acct123",
    bucket: "vp-test-files",
    key: "certificates/person_1/cert_1.pdf",
    body: Buffer.from("%PDF-1.4 fake certificate bytes"),
    contentType: "application/pdf",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2026-05-24T00:00:00Z"),
  };

  it("targets the correct R2 endpoint and bucket/key path", () => {
    const signed = signS3PutRequest(baseInput);
    expect(signed.method).toBe("PUT");
    expect(signed.url).toBe("https://acct123.r2.cloudflarestorage.com/vp-test-files/certificates/person_1/cert_1.pdf");
  });

  it("produces a well-formed AWS4-HMAC-SHA256 Authorization header with the right credential scope", () => {
    const signed = signS3PutRequest(baseInput);
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260524\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(signed.headers["x-amz-date"]).toBe("20260524T000000Z");
  });

  it("is deterministic: identical inputs produce an identical signature", () => {
    const a = signS3PutRequest(baseInput);
    const b = signS3PutRequest(baseInput);
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
  });

  it("changing the body changes the payload hash and the signature", () => {
    const a = signS3PutRequest(baseInput);
    const b = signS3PutRequest({ ...baseInput, body: Buffer.from("different bytes entirely") });
    expect(a.headers["x-amz-content-sha256"]).not.toBe(b.headers["x-amz-content-sha256"]);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("changing the secret key changes the signature but not the payload hash", () => {
    const a = signS3PutRequest(baseInput);
    const b = signS3PutRequest({ ...baseInput, secretAccessKey: "a-completely-different-secret-key" });
    expect(a.headers["x-amz-content-sha256"]).toBe(b.headers["x-amz-content-sha256"]);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("changing the key (path) changes the signature", () => {
    const a = signS3PutRequest(baseInput);
    const b = signS3PutRequest({ ...baseInput, key: "certificates/person_2/cert_2.pdf" });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("URL-encodes path segments in the signed key", () => {
    const signed = signS3PutRequest({ ...baseInput, key: "certificates/person 1/cert #1.pdf" });
    expect(signed.url).toContain("certificates/person%201/cert%20%231.pdf");
  });
});
