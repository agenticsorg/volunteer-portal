/**
 * Cloudflare R2 integration (ADR-0011) — certificate PDF upload only (the
 * one R2 asset class this bounded context owns). Same adapter-boundary
 * shape as `cloudflareStreamClient.ts`: application-layer use cases depend
 * on the `CertificateStorageAdapter` interface, never on this file's
 * concrete request/signing internals.
 *
 * No `@aws-sdk/client-s3` dependency exists anywhere in this monorepo (see
 * `apps/web/src/server/volunteering/pdf.ts`'s own header for the
 * established precedent of hand-writing a small, spec-correct
 * implementation rather than pulling in a new dependency for one call
 * site) — R2's S3-compatible PUT is authenticated with a standard AWS
 * Signature Version 4 request, computed here directly against
 * `node:crypto`, with no vendor SDK.
 *
 * This environment has no R2 credentials configured. `uploadCertificatePdf`
 * throws `ExternalServiceNotConfiguredError` naming the exact missing
 * environment variable rather than faking success — the SigV4 signing
 * logic itself is real and independently testable without a live network
 * call (see `tests/unit/cloudflareR2Client.test.ts`).
 */
import { createHash, createHmac } from "node:crypto";
import { ExternalServiceNotConfiguredError } from "../domain/errors";

const AWS_ALGORITHM = "AWS4-HMAC-SHA256";
const R2_SERVICE = "s3";
const R2_REGION = "auto"; // Cloudflare R2's fixed SigV4 region, per ADR-0011.

function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ExternalServiceNotConfiguredError(name, purpose);
  }
  return value;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `YYYYMMDD'T'HHMMSS'Z'` / `YYYYMMDD`, the two date formats SigV4 needs. */
function amzDateParts(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignedS3PutRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

/**
 * Computes a real AWS Signature Version 4 `PUT` request against an
 * S3-compatible endpoint (R2's), per AWS's documented canonical-request /
 * string-to-sign / signing-key algorithm. Exported standalone (not just
 * used internally) so its correctness is unit-testable in isolation —
 * deterministic given the same inputs, no network call, no clock
 * dependency beyond the `now` parameter.
 */
export function signS3PutRequest(input: {
  accountId: string;
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): SignedS3PutRequest {
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(input.now ?? new Date());
  const payloadHash = sha256Hex(input.body);
  const canonicalUri = `/${input.bucket}/${input.key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;

  const canonicalHeaders =
    `content-type:${input.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [
    AWS_ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, R2_REGION);
  const serviceKey = hmac(regionKey, R2_SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorizationHeader =
    `${AWS_ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    // Reuses `canonicalUri` (already percent-encoded per segment) rather
    // than re-interpolating the raw `input.key` — the actual HTTP request
    // must hit the exact path the signature was computed against, or R2
    // rejects it as a signature mismatch for any key containing spaces or
    // reserved characters.
    url: `https://${host}${canonicalUri}`,
    method: "PUT",
    headers: {
      Authorization: authorizationHeader,
      "Content-Type": input.contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}

export interface CertificateStorageAdapter {
  /**
   * Uploads a generated certificate PDF to R2 under
   * `certificates/{personId}/{enrollmentId}.pdf` (ADR-0011's key naming
   * convention, chapter-free — Certificate carries no chapterId). Returns
   * the R2 key persisted as `training.certificate.pdf_file_key`.
   */
  uploadCertificatePdf(key: string, bytes: Buffer): Promise<{ r2Key: string }>;
}

export const cloudflareR2Adapter: CertificateStorageAdapter = {
  async uploadCertificatePdf(key, bytes) {
    const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", "Uploading a certificate PDF to Cloudflare R2");
    const bucket = requireEnv("R2_BUCKET", "Uploading a certificate PDF to Cloudflare R2");
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID", "Uploading a certificate PDF to Cloudflare R2");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY", "Uploading a certificate PDF to Cloudflare R2");

    const signed = signS3PutRequest({
      accountId,
      bucket,
      key,
      body: bytes,
      contentType: "application/pdf",
      accessKeyId,
      secretAccessKey,
    });

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw new Error(`Cloudflare R2 upload to "${key}" failed: ${response.status} ${response.statusText}`);
    }

    return { r2Key: key };
  },
};
