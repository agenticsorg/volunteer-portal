/**
 * Local-filesystem-backed storage for DSAR export bundles.
 *
 * docs/ddd/identity-access.md's Key Use Case 6 describes export delivery
 * via cloud object storage and an async `graphile-worker` job; this
 * phase's task brief is explicit that "no real Supabase cloud project
 * exists for this app yet, and none will be created in this phase ...
 * do not block on this." No object-storage credentials (R2/S3/Supabase
 * Storage) exist to provision either, so this is a deliberate, documented
 * substitution: a real file is written to local disk and served back
 * through a real signed, expiring URL (`signing.ts`) — genuinely
 * downloadable and independently verifiable, just not yet backed by
 * durable cloud storage. `requestDataExport.ts` also runs this
 * synchronously rather than via a queued job, for the same reason
 * (documented on that file). Swapping in real object storage later only
 * touches this file and `signing.ts`'s URL-building — the
 * `DSARRequest` state machine and the `identityRouter`/REST surface stay
 * identical.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function exportDir(): string {
  return join(process.cwd(), ".data", "dsar-exports");
}

function exportFilePath(dsarId: string): string {
  return join(exportDir(), `${dsarId}.json`);
}

export async function writeExportBundle(dsarId: string, bundle: unknown): Promise<void> {
  mkdirSync(exportDir(), { recursive: true });
  writeFileSync(exportFilePath(dsarId), JSON.stringify(bundle, null, 2), { mode: 0o600 });
}

export async function readExportBundle(dsarId: string): Promise<string | null> {
  try {
    return readFileSync(exportFilePath(dsarId), "utf8");
  } catch {
    return null;
  }
}
