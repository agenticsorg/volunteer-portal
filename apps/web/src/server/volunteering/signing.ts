/**
 * Signs and verifies the signed, expiring download tokens
 * `hourEntries.exportApproved`'s `csvUrl` embeds — same real HMAC-SHA256
 * signing approach as `server/dsar/signing.ts` (see that file's header for
 * why the signing secret is a locally generated/persisted key rather than
 * one sourced from a secrets manager in this phase). Kept as its own
 * signing key/module rather than sharing DSAR's: a forged/expired
 * volunteering export-download token must never be checkable against — or
 * forgeable from — the DSAR signing key, since the two protect different
 * bounded contexts' data.
 */
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportFormat } from "./exportStorage";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function dataDir(): string {
  return join(process.cwd(), ".data");
}

function signingKeyPath(): string {
  return join(dataDir(), "volunteering-export-signing-key");
}

let cachedKey: Buffer | null = null;

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
  exportId: string;
  format: ExportFormat;
  exp: number; // ms since epoch
}

function hmac(payloadB64: string): string {
  return createHmac("sha256", getSigningKey()).update(payloadB64).digest("base64url");
}

export function signExportDownloadToken(
  exportId: string,
  format: ExportFormat,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const payload: ExportTokenPayload = { exportId, format, exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${hmac(payloadB64)}`;
}

/**
 * Verifies signature and expiry. Returns the payload on success, `null` on
 * any failure — callers should treat every failure case identically (a
 * generic 403/404), same "don't distinguish expired from forged" guidance
 * as `server/dsar/signing.ts`.
 */
export function verifyExportDownloadToken(token: string): ExportTokenPayload | null {
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
      typeof payload.exportId !== "string" ||
      (payload.format !== "csv" && payload.format !== "pdf") ||
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
