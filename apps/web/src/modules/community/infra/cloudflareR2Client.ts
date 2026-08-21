/**
 * Cloudflare R2 integration (ADR-0011) — Post attachment uploads, the one
 * R2 asset class this bounded context owns (docs/ddd/community-social.md's
 * Attachment value object: "a pointer to an object in Cloudflare R2
 * (`r2ObjectKey`) ... never binary data stored in Postgres"). Same
 * adapter-boundary shape as `modules/training/infra/cloudflareR2Client.ts`
 * (that module's certificate-PDF adapter): application-layer use cases
 * depend on the `PostAttachmentStorageAdapter` interface below, never on
 * this file's concrete signing internals.
 *
 * Deliberately its OWN adapter, not an import of `training`'s
 * `cloudflareR2Adapter`/`signS3PutRequest` — those are exported through
 * `modules/training`'s `index.ts` so importing them would pass the
 * module-boundary lint rule, but `training`'s adapter performs a
 * *server-executed* PUT (it already holds the bytes — a generated
 * certificate PDF — and signs a header-based SigV4 request it then
 * `fetch()`es itself). Post attachments are the opposite shape (ADR-0011:
 * "Presigned URL pattern keeps large file transfer off the ... compute
 * path entirely (client uploads/downloads directly to/from R2)") — this
 * server never sees the attachment bytes, it only mints a short-lived,
 * query-string-signed PUT URL the client uploads directly against.
 * Reusing `training`'s header-signing helper for a fundamentally different
 * signing shape would be a bigger coupling than hand-writing the ~30 lines
 * of query-string SigV4 this needs, so this module owns its own small,
 * independently testable implementation instead (same "hand-write a
 * small, spec-correct implementation rather than pull in
 * `@aws-sdk/client-s3`" precedent `training`'s own header comment cites).
 *
 * This environment has no R2 credentials configured. `createUploadUrl`
 * throws `ExternalServiceNotConfiguredError` naming the exact missing
 * environment variable rather than faking success — the SigV4 signing
 * logic itself is real and independently testable without a live network
 * call (deterministic given a fixed `now`), same as `training`'s adapter.
 */
import { createHash, createHmac } from "node:crypto";
import { ExternalServiceNotConfiguredError } from "../domain/errors";

const AWS_ALGORITHM = "AWS4-HMAC-SHA256";
const R2_SERVICE = "s3";
const R2_REGION = "auto"; // Cloudflare R2's fixed SigV4 region, per ADR-0011.
const DEFAULT_EXPIRES_IN_SECONDS = 900; // 15 min, ADR-0011's documented presigned-upload TTL.

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

export interface PresignedPutUrl {
  url: string;
  method: "PUT";
}

/**
 * Computes a real AWS Signature Version 4 **query-string-presigned** `PUT`
 * URL against an S3-compatible endpoint (R2's) — per AWS's documented
 * presigned-URL algorithm (`X-Amz-Signature` as a query parameter,
 * `UNSIGNED-PAYLOAD` since the signer here doesn't hold the body bytes to
 * hash). Exported standalone so its correctness is unit-testable in
 * isolation — deterministic given the same inputs, no network call, no
 * clock dependency beyond the `now` parameter.
 */
export function presignS3PutUrl(input: {
  accountId: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds?: number;
  now?: Date;
}): PresignedPutUrl {
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(input.now ?? new Date());
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const canonicalUri = `/${input.bucket}/${input.key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;

  const queryParams: Array<[string, string]> = [
    ["X-Amz-Algorithm", AWS_ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS)],
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

  const canonicalRequest = ["PUT", canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );

  const stringToSign = [AWS_ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, R2_REGION);
  const serviceKey = hmac(regionKey, R2_SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    url: `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`,
    method: "PUT",
  };
}

export interface PostAttachmentStorageAdapter {
  /**
   * Mints a short-lived, query-string-presigned R2 PUT URL for a
   * `community.post` attachment under `attachments/posts/{authorId}/{key}`
   * (ADR-0011's key-naming convention: `attachments/{context-asset-class}/
   * {owning-entity}/...`). The client uploads the attachment bytes
   * directly to R2 against this URL; this server never sees them.
   */
  createUploadUrl(key: string): Promise<PresignedPutUrl>;
}

export const cloudflareR2Adapter: PostAttachmentStorageAdapter = {
  async createUploadUrl(key) {
    const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", "Creating a Cloudflare R2 presigned upload URL");
    const bucket = requireEnv("R2_BUCKET", "Creating a Cloudflare R2 presigned upload URL");
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID", "Creating a Cloudflare R2 presigned upload URL");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY", "Creating a Cloudflare R2 presigned upload URL");

    return presignS3PutUrl({ accountId, bucket, key, accessKeyId, secretAccessKey });
  },
};
