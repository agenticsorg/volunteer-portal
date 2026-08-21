import type { PrismaClient } from "@prisma/client";
import { hasRoleInScope, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError } from "../domain/errors";

/** `hourEntries.listForPerson`'s per-item shape (API Contract Sketch). */
export interface HourEntryListItem {
  hourEntryId: string;
  personId: string;
  opportunityId: string;
  shiftId: string | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  description: string | null;
  status: string;
  submittedAt: string;
  approverPersonId: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface ListHourEntriesForPersonInput {
  caller: PolicySubject;
  personId: string;
  status?: "submitted" | "approved" | "rejected";
}

function toListItem(entry: {
  id: string;
  personId: string;
  opportunityId: string;
  shiftId: string | null;
  startAt: Date;
  endAt: Date;
  durationMinutes: number;
  description: string | null;
  status: string;
  submittedAt: Date;
  approverPersonId: string | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
}): HourEntryListItem {
  return {
    hourEntryId: entry.id,
    personId: entry.personId,
    opportunityId: entry.opportunityId,
    shiftId: entry.shiftId,
    startAt: entry.startAt.toISOString(),
    endAt: entry.endAt.toISOString(),
    durationMinutes: entry.durationMinutes,
    description: entry.description,
    status: entry.status,
    submittedAt: entry.submittedAt.toISOString(),
    approverPersonId: entry.approverPersonId,
    approvedAt: entry.approvedAt ? entry.approvedAt.toISOString() : null,
    rejectedAt: entry.rejectedAt ? entry.rejectedAt.toISOString() : null,
    rejectionReason: entry.rejectionReason,
  };
}

/**
 * `hourEntries.listForPerson` (API Contract Sketch) — a person's own hour
 * log. The contract sketch doesn't spell out an authorization rule for this
 * read, so this applies the same least-privilege default `identity` uses
 * for personal-data reads it doesn't otherwise document a policy for (see
 * `assertSelfOrOrgAdmin` in `server/api/routers/identity.ts`): the caller
 * must be the subject themselves, or hold `org_admin`. (A chapter-scoped
 * approver's own "hours awaiting my review" queue is a different read this
 * contract doesn't define — left for a later Admin & Reporting phase, same
 * "documented, not silently missing" shape as this module's other
 * deliberately-out-of-scope edges.)
 */
export async function listHourEntriesForPerson(
  prisma: PrismaClient,
  input: ListHourEntriesForPersonInput,
): Promise<HourEntryListItem[]> {
  if (input.caller.id !== input.personId) {
    const callerAssignments = await listActiveRoleAssignments(prisma, input.caller.id);
    const isOrgAdmin = hasRoleInScope(callerAssignments, "org_admin", "global", null);
    if (!isOrgAdmin) {
      throw new ForbiddenActionError("hour_entry.list_for_person");
    }
  }

  const entries = await prisma.hourEntry.findMany({
    where: { personId: input.personId, status: input.status },
    orderBy: { submittedAt: "desc" },
  });

  return entries.map(toListItem);
}
