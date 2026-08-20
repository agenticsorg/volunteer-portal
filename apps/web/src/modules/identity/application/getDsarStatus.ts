import type { IdentityDsarStatus, IdentityDsarType, PrismaClient } from "@prisma/client";
import { DsarRequestNotFoundError } from "../domain/errors";

/** The `identity-access-schema-api.md` contract's `dsar.getStatus` read shape. */
export interface DsarRequestStatus {
  dsarId: string;
  personId: string;
  type: IdentityDsarType;
  status: IdentityDsarStatus;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  exportFileUrl: string | null;
  failureReason: string | null;
}

export async function getDsarStatus(
  prisma: PrismaClient,
  dsarId: string,
): Promise<DsarRequestStatus> {
  const request = await prisma.dSARRequest.findUnique({ where: { id: dsarId } });
  if (!request) throw new DsarRequestNotFoundError(dsarId);

  return {
    dsarId: request.id,
    personId: request.personId,
    type: request.type,
    status: request.status,
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt.toISOString(),
    completedAt: request.completedAt ? request.completedAt.toISOString() : null,
    exportFileUrl: request.exportFileUrl,
    failureReason: request.failureReason,
  };
}
