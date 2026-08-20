/**
 * Shared-secret authentication for the versioned public REST surface's
 * admin-tooling endpoints — identity-access-schema-api.md's
 * `POST /api/v1/dsar/erasure-requests`: "org-admin only, API-key
 * authenticated". This is deliberately *not* a Supabase session: the doc
 * frames this REST surface as being "for external/admin tooling that
 * cannot use tRPC", i.e. a server-to-server caller with no browser/cookie
 * session to verify.
 *
 * A single process-wide secret (`ADMIN_API_KEY`) rather than a per-caller
 * key-issuance system — this phase has no cloud project to provision real
 * API-key management against (this phase's task brief: no Supabase cloud
 * project exists yet). The endpoint itself still re-derives "org-admin
 * only" from `identity.role_assignments` (via `requestErasure`'s own
 * `can()` check on the caller-supplied `requestedBy`), so a leaked API key
 * alone is not sufficient to erase an arbitrary person's data as a
 * non-admin `requestedBy` — this header only proves "this caller is
 * trusted admin tooling", not "this caller is a specific org_admin".
 * Swapping to per-key issuance/rotation later only touches this file.
 */
import { timingSafeEqual } from "node:crypto";

function getAdminApiKey(): string | null {
  const key = process.env.ADMIN_API_KEY;
  return key && key.length > 0 ? key : null;
}

/**
 * Constant-time comparison against the configured `ADMIN_API_KEY`. Returns
 * `false` (never throws) both when the header is missing/wrong and when
 * `ADMIN_API_KEY` itself isn't configured — a misconfigured deployment
 * fails closed rather than accepting every request.
 */
export function verifyAdminApiKey(request: Request): boolean {
  const provided = request.headers.get("x-api-key");
  const expected = getAdminApiKey();
  if (!provided || !expected) return false;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
