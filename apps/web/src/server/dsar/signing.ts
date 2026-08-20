/**
 * Signs and verifies the "signed, expiring URL" tokens
 * `identity.dsar_requests.export_file_url` values embed
 * (docs/ddd/identity-access.md Key Use Case 6: "a signed, expiring URL —
 * not stored data itself"; identity-access-schema-api.md's REST sketch:
 * `GET /api/v1/persons/:id/dsar-export` "signed URL redirect once
 * `completed`").
 *
 * Real HMAC-SHA256 signing, not a stand-in — a tampered or expired token
 * fails `verifyExportToken` exactly like a forged JWT would fail
 * signature verification. What *is* a deliberate, documented
 * simplification for this phase (see `exportStorage.ts`'s file header):
 * the signing secret is a locally generated/persisted key rather than a
 * value from a secrets manager, because this phase has no cloud
 * infrastructure to source one from (no real Supabase/cloud project
 * exists yet — see this phase's task brief). Swapping to an
 * environment-provided secret later is a one-line change inside
 * `getSigningKey()` only; every caller of `signExportToken`/
 * `verifyExportToken` is unaffected.
 */
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function dataDir(): string {
  return join(process.cwd(), ".data");
}

function signingKeyPath(): string {
  return join(dataDir(), "dsar-signing-key");
}

let cachedKey: Buffer | null = null;

/**
 * Reads the persisted local signing key, generating one on first use.
 * Cached in-process after the first call. `0o600` permissions (owner
 * read/write only) since this key's compromise would let an attacker
 * forge export-download URLs for any person.
 */
function getSigningKey(): Buffer {
  if (cachedKey) return cachedKey;

  const path = signingKeyPath();
  if (existsSync(path)) {
    cachedKey = readFileSync(path);
    return cachedKey;
  }

  mkdirSync(dataDir(), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

interface ExportTokenPayload {
  dsarId: string;
  personId: string;
  exp: number; // ms since epoch
}

function hmac(payloadB64: string): string {
  return createHmac("sha256", getSigningKey()).update(payloadB64).digest("base64url");
}

export function signExportToken(
  dsarId: string,
  personId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const payload: ExportTokenPayload = { dsarId, personId, exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${hmac(payloadB64)}`;
}

/**
 * Verifies signature and expiry. Returns the payload on success, `null`
 * on any failure (malformed token, bad signature, or expired) — callers
 * should treat every failure case identically (a generic 403/404), never
 * distinguishing "expired" from "forged" in the response, to avoid
 * leaking which failure mode occurred.
 */
export function verifyExportToken(token: string): ExportTokenPayload | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex <= 0) return null;

  const payloadB64 = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const expected = hmac(payloadB64);

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ExportTokenPayload;
    if (
      typeof payload.dsarId !== "string" ||
      typeof payload.personId !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
