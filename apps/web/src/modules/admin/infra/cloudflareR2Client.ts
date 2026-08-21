/**
 * Cloudflare R2 integration (ADR-0011) — grant-report export files, the one
 * R2 asset class this bounded context owns (docs/ddd/admin-reporting.md's
 * `ExportJob.outputFileKey`: "e.g. `exports/grant-reports/{chapterId}/
 * {exportId}.csv`, following the key convention established in ADR-0011").
 * Same adapter-boundary shape as `modules/training/infra/cloudflareR2Client.ts`
 * and `modules/moderation/infra/cloudflareR2Client.ts`: application-layer
 * use cases depend on the `ExportFileStorageAdapter` interface below, never
 * on this file's concrete signing internals.
 *
 * Two operations, mirroring the two R2 asset classes this context's own
 * lifecycle needs (docs/ddd/admin-reporting.md, Key Use Cases 5 and 7):
 *  - `uploadExportFile` — `ProcessExportJob` has the rendered CSV/PDF bytes
 *    in-process (this schema owns the render step, not a client), so this
 *    is a direct, server-signed `PUT`, same shape as `training`'s
 *    `uploadCertificatePdf` — not a presigned URL handed to a browser.
 *  - `createDownloadUrl` — `GetExportDownloadUrl` "mints a presigned R2 GET
 *    URL (15-minute TTL, per ADR-0011), never returns a raw bucket URL."
 *    Neither `training`'s nor `moderation`'s adapter needed a presigned
 *    *GET* before this phase (both only ever presign/direct-sign `PUT`s),
 *    so this is a new query-string-presigned-GET implementation, the same
 *    AWS SigV4 presigned-URL algorithm `moderation`'s `presignS3PutUrl`
 *    already uses, with `PUT` swapped for `GET` and no request body.
 *
 * No `@aws-sdk/client-s3` dependency exists anywhere in this monorepo —
 * same established precedent every other module's R2 adapter documents:
 * a small, spec-correct hand-written SigV4 implementation over
 * `node:crypto`, not a new vendor SDK dependency for a handful of call
 * sites.
 *
 * This environment has no R2 credentials configured. Both operations throw
 * `ExternalServiceNotConfiguredError` naming the exact missing environment
 * variable rather than faking success — the SigV4 signing logic itself is
 * real and independently testable without a live network call.
 */
import { createHash, createHmac } from "node:crypto";
import { ExternalServiceNotConfiguredError } from "../domain/errors";

const AWS_ALGORITHM = "AWS4-HMAC-SHA256";
const R2_SERVICE = "s3";
const R2_REGION = "auto"; // Cloudflare R2's fixed SigV4 region, per ADR-0011.

/** ADR-0011: "mints a presigned R2 GET URL (15-minute TTL, per ADR-0011)". */
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 900;

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

function canonicalUriFor(bucket: string, key: string): string {
  return `/${bucket}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function signingKeyFor(secretAccessKey: string, dateStamp: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, R2_REGION);
  const serviceKey = hmac(regionKey, R2_SERVICE);
  return hmac(serviceKey, "aws4_request");
}

export interface SignedS3PutRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

/**
 * A real AWS Signature Version 4 direct `PUT` request against an
 * S3-compatible endpoint — identical algorithm to
 * `modules/training/infra/cloudflareR2Client.ts`'s own `signS3PutRequest`,
 * duplicated rather than imported (that function lives in a sibling
 * module's private `infra/`, not exported through `training`'s `index.ts`
 * — importing it would itself violate the module-boundary rule this file's
 * header note already explains `moderation`'s own copy exists to avoid).
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
  const canonicalUri = canonicalUriFor(input.bucket, input.key);

  const canonicalHeaders =
    `content-type:${input.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [AWS_ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signature = createHmac("sha256", signingKeyFor(input.secretAccessKey, dateStamp))
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorizationHeader =
    `${AWS_ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
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

export interface PresignedGetUrl {
  url: string;
  method: "GET";
  expiresAt: Date;
}

/**
 * A real, query-string-presigned AWS Signature Version 4 `GET` URL — same
 * presigned-URL algorithm `modules/moderation/infra/cloudflareR2Client.ts`'s
 * `presignS3PutUrl` already uses (`X-Amz-Signature` as a query parameter,
 * `UNSIGNED-PAYLOAD`), with the HTTP method swapped and no
 * `Content-Type`/body to sign. Exported standalone so its correctness is
 * unit-testable in isolation — deterministic given the same inputs, no
 * network call, no clock dependency beyond the `now` parameter.
 */
export function presignS3GetUrl(input: {
  accountId: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds?: number;
  now?: Date;
}): PresignedGetUrl {
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDateParts(now);
  const expiresInSeconds = input.expiresInSeconds ?? DOWNLOAD_URL_EXPIRES_IN_SECONDS;
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const canonicalUri = canonicalUriFor(input.bucket, input.key);

  const queryParams: Array<[string, string]> = [
    ["X-Amz-Algorithm", AWS_ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQueryString = queryParams
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = ["GET", canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );

  const stringToSign = [AWS_ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKeyFor(input.secretAccessKey, dateStamp))
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`,
    method: "GET",
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
  };
}

export interface ExportFileStorageAdapter {
  /**
   * Uploads a rendered export file (CSV/PDF bytes `ProcessExportJob`
   * already holds in-process) to R2 under the caller-supplied key
   * (`exports/grant-reports/{chapterId}/{exportId}.{ext}`, ADR-0011).
   * Returns the key as-is — `ExportJob.outputFileKey` persists exactly
   * this value, never a full URL (Schema Sketch: "this schema stores the
   * key, never a public URL").
   */
  uploadExportFile(key: string, bytes: Buffer, contentType: string): Promise<{ r2Key: string }>;

  /**
   * Mints a short-lived (15-minute TTL, ADR-0011), presigned R2 GET URL for
   * an already-uploaded export file. `GetExportDownloadUrl` calls this only
   * after independently verifying `status = 'completed'` and
   * `outputFileExpiresAt > now()` — this adapter has no notion of
   * `ExportJob` state, it only ever signs the URL it's asked to sign.
   */
  createDownloadUrl(key: string): Promise<PresignedGetUrl>;
}

export const cloudflareR2Adapter: ExportFileStorageAdapter = {
  async uploadExportFile(key, bytes, contentType) {
    const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", "Uploading an export file to Cloudflare R2");
    const bucket = requireEnv("R2_BUCKET", "Uploading an export file to Cloudflare R2");
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID", "Uploading an export file to Cloudflare R2");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY", "Uploading an export file to Cloudflare R2");

    const signed = signS3PutRequest({ accountId, bucket, key, body: bytes, contentType, accessKeyId, secretAccessKey });

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

  async createDownloadUrl(key) {
    const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", "Creating a Cloudflare R2 presigned download URL");
    const bucket = requireEnv("R2_BUCKET", "Creating a Cloudflare R2 presigned download URL");
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID", "Creating a Cloudflare R2 presigned download URL");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY", "Creating a Cloudflare R2 presigned download URL");

    return presignS3GetUrl({ accountId, bucket, key, accessKeyId, secretAccessKey });
  },
};
