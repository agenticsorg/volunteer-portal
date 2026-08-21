/**
 * volunteering bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `volunteering`, per
 * ADR-0003. Procedures are thin adapters over `modules/volunteering/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; every `can()` check
 * (ADR-0007) happens inside the use case itself (via
 * `assertVolunteeringAuthority`), using the caller's own
 * `identity.role_assignments` (fetched via `listActiveRoleAssignments`).
 * This file's own job is: validate input, resolve the caller's
 * `PolicySubject`/`personId` from the *verified* session (never from
 * client input — same anti-corruption discipline as `identityRouter`),
 * translate domain errors to `TRPCError` codes, and — for
 * `hourEntries.exportApproved` only — apply the one `can()` check this
 * router performs directly (see that procedure's own doc comment).
 *
 * Shaped exactly per the API Contract Sketch in
 * docs/ddd/volunteering-opportunities-schema-api.md, with two additions
 * beyond that sketch, both required by this phase's own build list rather
 * than the sketch itself:
 *
 * - `opportunities.search` — ADR-0017 full-text search, explicitly called
 *   out as build item 3 ("Opportunity full-text search using the tsvector
 *   column"). Not part of the sketch's own `opportunities.list` (which
 *   only filters by `chapterId`/`status`/`category`), so it's a sibling
 *   procedure, matching `searchOpportunities.ts`'s own doc comment
 *   ("exposed as a distinct read alongside `list`").
 * - `applications.applyToShift` — the sketch names this procedure
 *   `applications.apply`, but tRPC v11's `router({})` hard-rejects `apply`
 *   as a key outright ("Reserved words used in `router({})` call: apply" —
 *   `call`/`apply`/`then` are reserved so a router's own callable/thenable
 *   surface can never be shadowed by a procedure name). Renamed to
 *   `applyToShift`, matching the underlying use case's own name
 *   (`applyToShift.ts`) exactly, so there is one obvious name across both
 *   layers instead of two different ones.
 * - `applications.decide` returns `void`, exactly as the sketch specifies,
 *   even though the underlying `decideApplication` use case resolves and
 *   returns the actual `outcome` ("accepted" vs. the possible
 *   capacity/prerequisite-forced "waitlisted" — DecideApplication
 *   invariant 5). The sketch is explicit about this mutation's return
 *   shape, so this router honors it literally rather than silently
 *   widening the contract; a caller that needs to know the actual outcome
 *   has `applications.listForShift` to re-read it.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid, newId } from "@volunteer-portal/ulid";
import { can, type PolicySubject, type Resource } from "@volunteer-portal/authz";
import {
  createOpportunity,
  publishOpportunity,
  listOpportunities,
  getOpportunityById,
  searchOpportunities,
  scheduleShift,
  cancelShift,
  listShiftsByOpportunity,
  applyToShift,
  decideApplication,
  withdrawApplication,
  listApplicationsForShift,
  submitHours,
  approveHours,
  rejectHours,
  listHourEntriesForPerson,
  queryApprovedHours,
  ForbiddenActionError,
  OpportunityNotFoundError,
  OpportunityNotPublishableError,
  InvalidOpportunityTransitionError,
  OpportunityHasScheduledShiftsError,
  ShiftNotFoundError,
  OpportunityNotPublishedError,
  ShiftTimeOrderError,
  ShiftCapacityInvalidError,
  ShiftNotOpenError,
  ShiftAlreadyDecidedError,
  ShiftHasApprovedHoursError,
  ApplicationNotFoundError,
  DuplicateApplicationError,
  ApplicationNotPendingError,
  NotTheApplicantError,
  ApplicationNotWithdrawableError,
  HourEntryNotFoundError,
  HourEntryNotSubmittedError,
  HourEntryDurationInvalidError,
  HourEntryTimeOrderError,
  HourEntryOutsideShiftWindowError,
  SelfApprovalNotAllowedError,
  RejectionReasonRequiredError,
  PersonNotFoundError,
} from "@/modules/volunteering";
import { listActiveRoleAssignments } from "@/modules/identity";
import { summarizeApprovedHours } from "@/server/volunteering/valuation";
import { buildApprovedHoursCsv } from "@/server/volunteering/csv";
import { writeExportFile } from "@/server/volunteering/exportStorage";
import { signExportDownloadToken } from "@/server/volunteering/signing";
import { dayStart, dayEnd } from "@/server/volunteering/dateRange";
import { router, publicProcedure, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

const locationTypeSchema = z.enum(["in_person", "remote", "hybrid"]);
const applicationDecisionSchema = z.enum(["accept", "decline", "waitlist"]);
const hourEntryStatusSchema = z.enum(["submitted", "approved", "rejected"]);
const opportunityStatusSchema = z.enum(["draft", "published", "closed", "archived"]);

/** Builds the `PolicySubject` every privileged use case's `caller` argument needs, from the already-resolved session `Person` — never a bare `{ id }` (see `PolicySubject`'s own doc comment on why `status` is required). */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/volunteering/application/`) to the appropriate `TRPCError`
 * code. Centralized here, same shape as `identityRouter`'s
 * `mapIdentityError`.
 */
function mapVolunteeringError(error: unknown): never {
  if (error instanceof ForbiddenActionError || error instanceof NotTheApplicantError || error instanceof SelfApprovalNotAllowedError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (
    error instanceof OpportunityNotFoundError ||
    error instanceof ShiftNotFoundError ||
    error instanceof ApplicationNotFoundError ||
    error instanceof HourEntryNotFoundError ||
    error instanceof PersonNotFoundError
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (
    error instanceof InvalidOpportunityTransitionError ||
    error instanceof OpportunityHasScheduledShiftsError ||
    error instanceof DuplicateApplicationError ||
    error instanceof ApplicationNotPendingError ||
    error instanceof ApplicationNotWithdrawableError ||
    error instanceof ShiftAlreadyDecidedError ||
    error instanceof ShiftHasApprovedHoursError ||
    error instanceof HourEntryNotSubmittedError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (
    error instanceof ShiftTimeOrderError ||
    error instanceof ShiftCapacityInvalidError ||
    error instanceof HourEntryDurationInvalidError ||
    error instanceof HourEntryTimeOrderError ||
    error instanceof HourEntryOutsideShiftWindowError ||
    error instanceof RejectionReasonRequiredError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof OpportunityNotPublishableError || error instanceof OpportunityNotPublishedError || error instanceof ShiftNotOpenError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  }
  throw error;
}

const createOpportunityInputSchema = z.object({
  chapterId: ulidSchema.nullable(),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  skillsRequired: z.array(z.string()).default([]),
  locationType: locationTypeSchema,
  minAge: z.number().int().min(13).default(16),
  prerequisiteCourseIds: z.array(ulidSchema).default([]),
});

const scheduleShiftInputSchema = z.object({
  opportunityId: ulidSchema,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().min(1),
  capacity: z.number().int().min(1),
});

const submitHoursInputSchema = z.object({
  opportunityId: ulidSchema,
  shiftId: ulidSchema.nullable(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  description: z.string().optional(),
});

const exportApprovedInputSchema = z.object({
  chapterId: ulidSchema.optional(),
  opportunityId: ulidSchema.optional(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
  hourlyRate: z.number().positive().optional(),
});

export const volunteeringRouter = router({
  opportunities: router({
    create: protectedProcedure.input(createOpportunityInputSchema).mutation(async ({ ctx, input }) => {
      try {
        return await createOpportunity(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapVolunteeringError(error);
      }
    }),

    publish: protectedProcedure
      .input(z.object({ opportunityId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          await publishOpportunity(ctx.prisma, { caller: callerSubject(ctx.person), opportunityId: input.opportunityId });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    list: publicProcedure
      .input(
        z.object({
          chapterId: ulidSchema.optional(),
          status: z.enum(["published"]).default("published"),
          category: z.string().optional(),
          cursor: ulidSchema.optional(),
          limit: z.number().int().max(50).default(20),
        }),
      )
      .query(({ ctx, input }) => listOpportunities(ctx.prisma, input)),

    getById: publicProcedure
      .input(z.object({ id: ulidSchema }))
      .query(({ ctx, input }) => getOpportunityById(ctx.prisma, input.id)),

    /** ADR-0017 full-text search (build item 3) — see this file's header. */
    search: publicProcedure
      .input(
        z.object({
          query: z.string().min(1),
          chapterId: ulidSchema.optional(),
          status: opportunityStatusSchema.optional(),
          limit: z.number().int().max(50).optional(),
        }),
      )
      .query(({ ctx, input }) => searchOpportunities(ctx.prisma, input)),
  }),

  shifts: router({
    schedule: protectedProcedure.input(scheduleShiftInputSchema).mutation(async ({ ctx, input }) => {
      try {
        return await scheduleShift(ctx.prisma, {
          caller: callerSubject(ctx.person),
          opportunityId: input.opportunityId,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          timezone: input.timezone,
          capacity: input.capacity,
        });
      } catch (error) {
        mapVolunteeringError(error);
      }
    }),

    cancel: protectedProcedure
      .input(z.object({ shiftId: ulidSchema, reason: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        try {
          await cancelShift(ctx.prisma, { caller: callerSubject(ctx.person), shiftId: input.shiftId, reason: input.reason });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    listByOpportunity: publicProcedure
      .input(z.object({ opportunityId: ulidSchema }))
      .query(({ ctx, input }) => listShiftsByOpportunity(ctx.prisma, input.opportunityId)),
  }),

  applications: router({
    applyToShift: protectedProcedure.input(z.object({ shiftId: ulidSchema })).mutation(async ({ ctx, input }) => {
      try {
        return await applyToShift(ctx.prisma, { applicantPersonId: ctx.person.personId, shiftId: input.shiftId });
      } catch (error) {
        mapVolunteeringError(error);
      }
    }),

    decide: protectedProcedure
      .input(
        z.object({
          applicationId: ulidSchema,
          decision: applicationDecisionSchema,
          decisionNote: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          await decideApplication(ctx.prisma, {
            caller: callerSubject(ctx.person),
            applicationId: input.applicationId,
            decision: input.decision,
            decisionNote: input.decisionNote,
          });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    withdraw: protectedProcedure
      .input(z.object({ applicationId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          await withdrawApplication(ctx.prisma, { callerId: ctx.person.personId, applicationId: input.applicationId });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    listForShift: protectedProcedure
      .input(z.object({ shiftId: ulidSchema }))
      .query(async ({ ctx, input }) => {
        try {
          return await listApplicationsForShift(ctx.prisma, callerSubject(ctx.person), input.shiftId);
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),
  }),

  hourEntries: router({
    submit: protectedProcedure.input(submitHoursInputSchema).mutation(async ({ ctx, input }) => {
      try {
        return await submitHours(ctx.prisma, {
          personId: ctx.person.personId,
          opportunityId: input.opportunityId,
          shiftId: input.shiftId,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          description: input.description ?? null,
        });
      } catch (error) {
        mapVolunteeringError(error);
      }
    }),

    approve: protectedProcedure
      .input(z.object({ hourEntryId: ulidSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          await approveHours(ctx.prisma, { caller: callerSubject(ctx.person), hourEntryId: input.hourEntryId });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    reject: protectedProcedure
      .input(z.object({ hourEntryId: ulidSchema, rejectionReason: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        try {
          await rejectHours(ctx.prisma, {
            caller: callerSubject(ctx.person),
            hourEntryId: input.hourEntryId,
            rejectionReason: input.rejectionReason,
          });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    listForPerson: protectedProcedure
      .input(z.object({ personId: ulidSchema, status: hourEntryStatusSchema.optional() }))
      .query(async ({ ctx, input }) => {
        try {
          return await listHourEntriesForPerson(ctx.prisma, {
            caller: callerSubject(ctx.person),
            personId: input.personId,
            status: input.status,
          });
        } catch (error) {
          mapVolunteeringError(error);
        }
      }),

    /**
     * `hourEntries.exportApproved` (Key Use Case 10, `ExportApprovedHours`)
     * — "requires `can(caller, 'hours.export')`". This is the one `can()`
     * check this router performs directly rather than delegating to a use
     * case: `queryApprovedHours` (the module's read function this wraps)
     * deliberately carries no authorization gate of its own — see that
     * function's doc comment, "belongs at the calling procedure/router
     * layer, once one exists to call it from." That layer is this
     * procedure. `hours.export` (packages/authz) resolves to "org_admin,
     * or chapter_lead scoped to `chapterId` when a chapter filter is
     * supplied" — an unfiltered (org-wide) export requires `org_admin`.
     *
     * Renders both the CSV artifact this returns a signed download link
     * for, and the `totalHours`/`totalValue` summary, from the exact same
     * filtered `queryApprovedHours` read — never re-queried between the
     * two, so the numbers and the file can never disagree.
     */
    exportApproved: protectedProcedure.input(exportApprovedInputSchema).query(async ({ ctx, input }) => {
      const caller = callerSubject(ctx.person);
      const assignments = await listActiveRoleAssignments(ctx.prisma, caller.id);
      const resource: Resource = input.chapterId
        ? { type: "hour_entry", scopeType: "chapter", scopeId: input.chapterId }
        : { type: "hour_entry", scopeType: "global", scopeId: null };
      if (!can(caller, "hours.export", resource, assignments)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not authorized to export approved hours." });
      }

      const records = await queryApprovedHours(ctx.prisma, {
        chapterId: input.chapterId,
        opportunityId: input.opportunityId,
        fromDate: dayStart(input.fromDate),
        toDate: dayEnd(input.toDate),
      });

      const summary = summarizeApprovedHours(records, input.hourlyRate);
      const exportId = newId();
      await writeExportFile(exportId, "csv", buildApprovedHoursCsv(records));
      const token = signExportDownloadToken(exportId, "csv");

      return {
        csvUrl: `/api/v1/hour-entries/export/${exportId}?token=${token}`,
        totalHours: summary.totalHours,
        totalValue: summary.totalValue,
      };
    }),
  }),
});
