/**
 * Local-filesystem-backed storage for `hourEntries.exportApproved`'s
 * grant-report artifacts — same documented substitution as
 * `server/dsar/exportStorage.ts` (no R2/S3/Supabase Storage credentials
 * exist to provision in this phase; see that file's header for the full
 * rationale). A real file is written to local disk and served back
 * through a real signed, expiring URL (`signing.ts`).
 *
 * Deliberately its own directory/module rather than reusing
 * `server/dsar/exportStorage.ts` — `volunteering`'s exports are a
 * different bounded context's artifact with a different retention/access
 * story (grant reports, not a person's own DSAR bundle), so sharing
 * storage would blur that boundary for no benefit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ExportFormat = "csv" | "pdf";

function exportDir(): string {
  return join(process.cwd(), ".data", "volunteering-exports");
}

function exportFilePath(exportId: string, format: ExportFormat): string {
  return join(exportDir(), `${exportId}.${format}`);
}

export async function writeExportFile(
  exportId: string,
  format: ExportFormat,
  content: string | Buffer,
): Promise<void> {
  mkdirSync(exportDir(), { recursive: true });
  writeFileSync(exportFilePath(exportId, format), content, { mode: 0o600 });
}

export async function readExportFile(
  exportId: string,
  format: ExportFormat,
): Promise<Buffer | null> {
  try {
    return readFileSync(exportFilePath(exportId, format));
  } catch {
    return null;
  }
}
