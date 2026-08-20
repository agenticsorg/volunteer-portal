import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { ApplicationNotFoundError, ApplicationNotPendingError } from "../domain/errors";
import { assertVolunteeringAuthority } from "./assertVolunteeringAuthority";
import { hasCompletedRequiredTraining } from "./hasCompletedRequiredTraining";

export type ApplicationDecision = "accept" | "decline" | "waitlist";

/**
 * DecideApplication (docs/ddd/volunteering-opportunities.md, Key Use Case 5).
 *
 * *Pre:* Application is `pending`; caller is authorized to decide
 * applications for this Opportunity (`application.decide` — `chapter_lead`/
 * `mentor` scoped to the Opportunity's chapter, or `org_admin`); if
 * `decision === 'accept'`, the applicant must satisfy the parent
 * Opportunity's `prerequisiteCourseIds`
 * (`hasCompletedRequiredTraining` — stubbed `true` this phase) **and**
 * `Shift.acceptedCount < capacity` — when either is false, the outcome is
 * silently forced to `waitlisted` instead of `accepted` (not an error; this
 * is the documented behavior, not a failure case).
 *
 * *Post:* `Application.status` updated with `decidedByPersonId`/
 * `decidedAt`; if the actual outcome is `accepted`, `Shift.acceptedCount`
 * is incremented **in the same transaction**, via a single atomic
 * conditional `UPDATE ... WHERE accepted_count < capacity` (Shift invariant
 * 3's concurrency guarantee — no read-then-write race window even under
 * concurrent `DecideApplication`/`WithdrawApplication` calls on the same
 * shift, since Postgres serializes conflicting `UPDATE`s on the same row);
 * the corresponding event (`ApplicationAccepted`/`ApplicationWaitlisted`/
 * `ApplicationDeclined`) is emitted.
 */
export interface DecideApplicationInput {
  caller: PolicySubject;
  applicationId: string;
  decision: ApplicationDecision;
  decisionNote?: string;
}

export interface DecidedApplication {
  outcome: "accepted" | "declined" | "waitlisted";
}

export async function decideApplication(
  prisma: PrismaClient,
  input: DecideApplicationInput,
): Promise<DecidedApplication> {
  const application = await prisma.application.findUnique({
    where: { id: input.applicationId },
    select: {
      id: true,
      shiftId: true,
      applicantPersonId: true,
      status: true,
      shift: {
        select: {
          id: true,
          opportunityId: true,
          opportunity: { select: { chapterId: true, prerequisiteCourseIds: true } },
        },
      },
    },
  });
  if (!application) {
    throw new ApplicationNotFoundError(input.applicationId);
  }

  await assertVolunteeringAuthority(
    prisma,
    input.caller,
    "application.decide",
    "application",
    application.shift.opportunity.chapterId,
  );

  if (application.status !== "pending") {
    throw new ApplicationNotPendingError(application.id, application.status);
  }

  const decidedAt = new Date();

  if (input.decision === "decline") {
    return applyDeclineOutcome(prisma, application, input, decidedAt);
  }

  if (input.decision === "waitlist") {
    return applyWaitlistOutcome(prisma, application, input, decidedAt);
  }

  // decision === "accept": the actual outcome depends on prerequisites and
  // live capacity, resolved atomically inside the transaction below.
  const trainingSatisfied = await hasCompletedRequiredTraining(
    application.applicantPersonId,
    application.shift.opportunity.prerequisiteCourseIds,
  );
  if (!trainingSatisfied) {
    return applyWaitlistOutcome(prisma, application, input, decidedAt);
  }

  let outcome: DecidedApplication["outcome"] = "waitlisted";
  await prisma.$transaction(async (tx) => {
    const incremented = await tx.$executeRaw`
      UPDATE volunteering.shifts
      SET accepted_count = accepted_count + 1, updated_at = now()
      WHERE id = ${application.shiftId} AND accepted_count < capacity
    `;

    outcome = incremented === 1 ? "accepted" : "waitlisted";

    await tx.application.update({
      where: { id: application.id, status: "pending" },
      data: {
        status: outcome,
        decidedByPersonId: input.caller.id,
        decidedAt,
        decisionNote: input.decisionNote ?? null,
      },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Application",
        aggregateId: application.id,
        eventType: outcome === "accepted" ? "ApplicationAccepted" : "ApplicationWaitlisted",
        payload: (outcome === "accepted"
          ? {
              applicationId: application.id,
              shiftId: application.shiftId,
              opportunityId: application.shift.opportunityId,
              applicantPersonId: application.applicantPersonId,
              decidedAt: decidedAt.toISOString(),
            }
          : {
              applicationId: application.id,
              shiftId: application.shiftId,
              applicantPersonId: application.applicantPersonId,
              decidedAt: decidedAt.toISOString(),
            }) satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "application.decide",
      resourceType: "application",
      resourceId: application.id,
      scopeType: application.shift.opportunity.chapterId ? "chapter" : "global",
      scopeId: application.shift.opportunity.chapterId ?? undefined,
      metadata: { requestedDecision: input.decision, outcome },
    });
  });

  return { outcome };
}

interface LoadedApplication {
  id: string;
  shiftId: string;
  applicantPersonId: string;
  shift: { id: string; opportunityId: string; opportunity: { chapterId: string | null } };
}

async function applyDeclineOutcome(
  prisma: PrismaClient,
  application: LoadedApplication,
  input: DecideApplicationInput,
  decidedAt: Date,
): Promise<DecidedApplication> {
  await prisma.$transaction(async (tx) => {
    await tx.application.update({
      where: { id: application.id, status: "pending" },
      data: {
        status: "declined",
        decidedByPersonId: input.caller.id,
        decidedAt,
        decisionNote: input.decisionNote ?? null,
      },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Application",
        aggregateId: application.id,
        eventType: "ApplicationDeclined",
        payload: {
          applicationId: application.id,
          shiftId: application.shiftId,
          applicantPersonId: application.applicantPersonId,
          decidedAt: decidedAt.toISOString(),
          decisionNote: input.decisionNote ?? null,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "application.decide",
      resourceType: "application",
      resourceId: application.id,
      scopeType: application.shift.opportunity.chapterId ? "chapter" : "global",
      scopeId: application.shift.opportunity.chapterId ?? undefined,
      metadata: { requestedDecision: "decline", outcome: "declined" },
    });
  });

  return { outcome: "declined" };
}

async function applyWaitlistOutcome(
  prisma: PrismaClient,
  application: LoadedApplication,
  input: DecideApplicationInput,
  decidedAt: Date,
): Promise<DecidedApplication> {
  await prisma.$transaction(async (tx) => {
    await tx.application.update({
      where: { id: application.id, status: "pending" },
      data: {
        status: "waitlisted",
        decidedByPersonId: input.caller.id,
        decidedAt,
        decisionNote: input.decisionNote ?? null,
      },
    });

    await tx.volunteeringDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Application",
        aggregateId: application.id,
        eventType: "ApplicationWaitlisted",
        payload: {
          applicationId: application.id,
          shiftId: application.shiftId,
          applicantPersonId: application.applicantPersonId,
          decidedAt: decidedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.volunteeringDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "application.decide",
      resourceType: "application",
      resourceId: application.id,
      scopeType: application.shift.opportunity.chapterId ? "chapter" : "global",
      scopeId: application.shift.opportunity.chapterId ?? undefined,
      metadata: { requestedDecision: input.decision, outcome: "waitlisted" },
    });
  });

  return { outcome: "waitlisted" };
}
