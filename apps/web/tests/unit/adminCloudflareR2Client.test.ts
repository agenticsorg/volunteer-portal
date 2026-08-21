import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloudflareR2Adapter,
  presignS3GetUrl,
  signS3PutRequest,
  ExternalServiceNotConfiguredError,
} from "@/modules/admin";

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

// This environment has no live Cloudflare R2 credentials (this phase's own
// brief). `uploadExportFile`/`createDownloadUrl` must throw
// `ExternalServiceNotConfiguredError` (never fake success) when
// unconfigured; `signS3PutRequest`/`presignS3GetUrl`'s real AWS SigV4
// signing logic is exercised directly and in isolation — no live network
// call, no real R2 bucket. Same precedent as
// `tests/unit/cloudflareR2Client.test.ts` (training's identically-shaped
// adapter) and `tests/unit/resendClient.test.ts`.
describe("cloudflareR2Adapter (admin) — not configured in this environment", () => {
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

  it("uploadExportFile throws ExternalServiceNotConfiguredError naming CLOUDFLARE_ACCOUNT_ID", async () => {
    await expect(
      cloudflareR2Adapter.uploadExportFile("exports/grant-reports/all-chapters/x.csv", Buffer.from("csv"), "text/csv"),
    ).rejects.toBeInstanceOf(ExternalServiceNotConfiguredError);
    await expect(
      cloudflareR2Adapter.uploadExportFile("exports/grant-reports/all-chapters/x.csv", Buffer.from("csv"), "text/csv"),
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("createDownloadUrl throws ExternalServiceNotConfiguredError naming CLOUDFLARE_ACCOUNT_ID", async () => {
    await expect(
      cloudflareR2Adapter.createDownloadUrl("exports/grant-reports/all-chapters/x.csv"),
    ).rejects.toBeInstanceOf(ExternalServiceNotConfiguredError);
    await expect(
      cloudflareR2Adapter.createDownloadUrl("exports/grant-reports/all-chapters/x.csv"),
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });
});

describe("signS3PutRequest (real AWS SigV4, no network)", () => {
  const baseInput = {
    accountId: "acct123",
    bucket: "vp-test-exports",
    key: "exports/grant-reports/chapter_1/export_1.csv",
    body: Buffer.from("personId,personName\n"),
    contentType: "text/csv",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2026-05-24T00:00:00Z"),
  };

  it("targets the correct R2 endpoint and bucket/key path", () => {
    const signed = signS3PutRequest(baseInput);
    expect(signed.method).toBe("PUT");
    expect(signed.url).toBe(
      "https://acct123.r2.cloudflarestorage.com/vp-test-exports/exports/grant-reports/chapter_1/export_1.csv",
    );
  });

  it("produces a well-formed AWS4-HMAC-SHA256 Authorization header with the right credential scope", () => {
    const signed = signS3PutRequest(baseInput);
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260524\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("changing the body changes the payload hash and the signature", () => {
    const a = signS3PutRequest(baseInput);
    const b = signS3PutRequest({ ...baseInput, body: Buffer.from("entirely different csv bytes") });
    expect(a.headers["x-amz-content-sha256"]).not.toBe(b.headers["x-amz-content-sha256"]);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });
});

describe("presignS3GetUrl (real AWS SigV4 query-string presigning, no network)", () => {
  const baseInput = {
    accountId: "acct123",
    bucket: "vp-test-exports",
    key: "exports/grant-reports/chapter_1/export_1.csv",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2026-05-24T00:00:00Z"),
  };

  it("targets the correct R2 endpoint/bucket/key and signs as a GET", () => {
    const signed = presignS3GetUrl(baseInput);
    expect(signed.method).toBe("GET");
    expect(signed.url).toContain(
      "https://acct123.r2.cloudflarestorage.com/vp-test-exports/exports/grant-reports/chapter_1/export_1.csv?",
    );
  });

  it("defaults to a 15-minute (900s) TTL, per ADR-0011, reflected in both X-Amz-Expires and expiresAt", () => {
    const signed = presignS3GetUrl(baseInput);
    expect(signed.url).toContain("X-Amz-Expires=900");
    expect(signed.expiresAt.getTime()).toBe(baseInput.now.getTime() + 900_000);
  });

  it("honors a caller-supplied expiresInSeconds override", () => {
    const signed = presignS3GetUrl({ ...baseInput, expiresInSeconds: 60 });
    expect(signed.url).toContain("X-Amz-Expires=60");
    expect(signed.expiresAt.getTime()).toBe(baseInput.now.getTime() + 60_000);
  });

  it("carries the signature as a query parameter, not a header (query-string presigning)", () => {
    const signed = presignS3GetUrl(baseInput);
    expect(signed.url).toMatch(/[?&]X-Amz-Signature=[0-9a-f]{64}(&|$)/);
    expect(signed.url).toMatch(/[?&]X-Amz-Algorithm=AWS4-HMAC-SHA256(&|$)/);
    expect(signed.url).toMatch(/[?&]X-Amz-SignedHeaders=host(&|$)/);
  });

  it("is deterministic: identical inputs produce an identical signature", () => {
    const a = presignS3GetUrl(baseInput);
    const b = presignS3GetUrl(baseInput);
    expect(a.url).toBe(b.url);
  });

  it("changing the key changes the signature", () => {
    const a = presignS3GetUrl(baseInput);
    const b = presignS3GetUrl({ ...baseInput, key: "exports/grant-reports/chapter_2/export_2.csv" });
    expect(a.url).not.toBe(b.url);
  });
});
