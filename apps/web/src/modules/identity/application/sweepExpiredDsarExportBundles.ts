import type { PrismaClient } from "@prisma/client";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { deleteExportBundle } from "@/server/dsar/exportStorage";

export interface SweepExpiredDsarExportBundlesResult {
  deletedCount: number;
}

/**
 * `identity.sweepExpiredDsarExportBundles(cutoff)` — the
 * `dsar_export_bundles` data class's owning-schema cleanup function
 * (ADR-0014 §3: "7 days -> hard_delete (R2 lifecycle rule mirrors
 * this)"), invoked directly by `admin`'s `retention_sweep` job and
 * exported through this module's own `index.ts` (ADR-0001).
 *
 * Targets completed `export`-type `DSARRequest` rows whose
 * `completedAt < cutoff` and that still have a bundle to delete
 * (`exportFileUrl IS NOT NULL`) — deletes the underlying local-disk file
 * (`exportStorage.ts`'s documented substitute for a real R2 lifecycle
 * rule) and clears `exportFileUrl` so a stale signed link can never be
 * re-derived. `hard_delete`, per the policy's own `action` — unlike
 * `inactive_volunteer_pii`/`moderation_logs`, nothing here is anonymized
 * in place, because the `DSARRequest` row itself (id, type, status,
 * timestamps) carries no PII beyond the link already being removed, and
 * ADR-0014 draws no exception for this data class the way it does for
 * hour entries.
 */
export async function sweepExpiredDsarExportBundles(
  prisma: PrismaClient,
  cutoff: Date,
): Promise<SweepExpiredDsarExportBundlesResult> {
  const stale = await prisma.dSARRequest.findMany({
    where: { type: "export", status: "completed", completedAt: { lt: cutoff }, exportFileUrl: { not: null } },
    select: { id: true },
  });

  for (const request of stale) {
    await deleteExportBundle(request.id);
    await prisma.$transaction(async (tx) => {
      await tx.dSARRequest.update({ where: { id: request.id }, data: { exportFileUrl: null } });
      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: null,
        actorType: "system",
        action: "dsar.export_bundle.expired",
        resourceType: "dsar_request",
        resourceId: request.id,
        metadata: { dataClass: "dsar_export_bundles" },
      });
    });
  }

  return { deletedCount: stale.length };
}
