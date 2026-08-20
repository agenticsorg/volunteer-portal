import type { PrismaClient } from "@prisma/client";
import type { PolicySubject } from "@volunteer-portal/authz";
import { ShiftNotFoundError } from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";

/** `applications.listForShift`'s per-item shape (API Contract Sketch). */
export interface ApplicationListItem {
  applicationId: string;
  shiftId: string;
  applicantPersonId: string;
  status: string;
  appliedAt: string;
  decidedByPersonId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/**
 * `applications.listForShift` (API Contract Sketch). Unlike the public
 * Opportunity/Shift reads, this exposes every applicant's identity for a
 * shift — not public data — so it's gated the same way `DecideApplication`
 * itself is (`application.decide`: `chapter_lead`/`mentor` scoped to the
 * Opportunity's chapter, or `org_admin`; ADR-0007: "Field-level checks
 * reuse the same primitive" — a read reusing a mutation's action name to
 * gate visibility is exactly this pattern, not a new action).
 */
export async function listApplicationsForShift(
  prisma: PrismaClient,
  caller: PolicySubject,
  shiftId: string,
): Promise<ApplicationListItem[]> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: { id: true, opportunity: { select: { chapterId: true } } },
  });
  if (!shift) {
    throw new ShiftNotFoundError(shiftId);
  }

  await assertVolunteeringAuthority(prisma, caller, "application.decide", "application", shift.opportunity.chapterId);

  const applications = await prisma.application.findMany({
    where: { shiftId },
    orderBy: { appliedAt: "asc" },
  });

  return applications.map((application) => ({
    applicationId: application.id,
    shiftId: application.shiftId,
    applicantPersonId: application.applicantPersonId,
    status: application.status,
    appliedAt: application.appliedAt.toISOString(),
    decidedByPersonId: application.decidedByPersonId,
    decidedAt: application.decidedAt ? application.decidedAt.toISOString() : null,
    decisionNote: application.decisionNote,
  }));
}
