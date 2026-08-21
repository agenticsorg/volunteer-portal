import type { PrismaClient } from "@prisma/client";

export interface KudosDTO {
  kudosId: string;
  fromPersonId: string;
  toPersonId: string;
  note: string | null;
  achievementRefType: string | null;
  achievementRefId: string | null;
  createdAt: string;
}

export interface GetKudosReceivedInput {
  personId: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

/**
 * `kudos.getReceived` (docs/ddd/community-social.md's API Contract
 * Sketch) — one person's received-kudos history, newest first
 * (`idx_kudos_to_person`). A plain, un-gated read, same "public
 * projection" shape as `identity`'s `getPersonSummary` — kudos are
 * peer-recognition, not private data.
 */
export async function getKudosReceived(
  prisma: PrismaClient,
  input: GetKudosReceivedInput,
): Promise<KudosDTO[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.kudos.findMany({
    where: {
      toPersonId: input.personId,
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    kudosId: row.id,
    fromPersonId: row.fromPersonId,
    toPersonId: row.toPersonId,
    note: row.note,
    achievementRefType: row.achievementRefType,
    achievementRefId: row.achievementRefId,
    createdAt: row.createdAt.toISOString(),
  }));
}
