import type { PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";

/**
 * Shared fixtures for the Phase 3 volunteering-use-case integration suites,
 * same "insert directly via Prisma, don't depend on the use case under
 * test to create its own prerequisites" shape as
 * `helpers/identityFixtures.ts`.
 */

export function callerSubject(person: { id: string; status: string }): PolicySubject {
  return { id: person.id, status: person.status as PolicySubject["status"] };
}

export async function createOpportunityDirect(
  prisma: PrismaClient,
  overrides: Partial<{
    chapterId: string | null;
    status: "draft" | "published" | "closed" | "archived";
    title: string;
    createdByPersonId: string;
    prerequisiteCourseIds: string[];
  }> = {},
) {
  const id = newId();
  return prisma.opportunity.create({
    data: {
      id,
      chapterId: overrides.chapterId ?? null,
      title: overrides.title ?? "Test Opportunity",
      description: "A test opportunity used by integration tests.",
      category: "event-support",
      locationType: "in_person",
      createdByPersonId: overrides.createdByPersonId ?? newId(),
      status: overrides.status ?? "published",
      publishedAt: (overrides.status ?? "published") !== "draft" ? new Date() : null,
      prerequisiteCourseIds: overrides.prerequisiteCourseIds ?? [],
    },
  });
}

export async function createShiftDirect(
  prisma: PrismaClient,
  overrides: {
    opportunityId: string;
    capacity?: number;
    status?: "scheduled" | "cancelled" | "completed";
    startsAt?: Date;
    endsAt?: Date;
    acceptedCount?: number;
  },
) {
  const id = newId();
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = overrides.endsAt ?? new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  return prisma.shift.create({
    data: {
      id,
      opportunityId: overrides.opportunityId,
      startsAt,
      endsAt,
      timezone: "UTC",
      capacity: overrides.capacity ?? 1,
      acceptedCount: overrides.acceptedCount ?? 0,
      status: overrides.status ?? "scheduled",
    },
  });
}

export async function createApplicationDirect(
  prisma: PrismaClient,
  overrides: {
    shiftId: string;
    applicantPersonId: string;
    status?: "pending" | "accepted" | "waitlisted" | "declined" | "withdrawn";
    appliedAt?: Date;
  },
) {
  const id = newId();
  return prisma.application.create({
    data: {
      id,
      shiftId: overrides.shiftId,
      applicantPersonId: overrides.applicantPersonId,
      status: overrides.status ?? "pending",
      appliedAt: overrides.appliedAt ?? new Date(),
    },
  });
}

export async function createHourEntryDirect(
  prisma: PrismaClient,
  overrides: {
    personId: string;
    opportunityId: string;
    shiftId?: string | null;
    status?: "submitted" | "approved" | "rejected";
    durationMinutes?: number;
    approverPersonId?: string | null;
    approvedAt?: Date | null;
  },
) {
  const id = newId();
  const startAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const durationMinutes = overrides.durationMinutes ?? 60;
  return prisma.hourEntry.create({
    data: {
      id,
      personId: overrides.personId,
      opportunityId: overrides.opportunityId,
      shiftId: overrides.shiftId ?? null,
      startAt,
      endAt: new Date(startAt.getTime() + durationMinutes * 60_000),
      durationMinutes,
      status: overrides.status ?? "submitted",
      approverPersonId: overrides.approverPersonId ?? null,
      approvedAt: overrides.approvedAt ?? null,
    },
  });
}
