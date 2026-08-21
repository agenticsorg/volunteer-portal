/**
 * admin bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `admin`, per ADR-0003.
 * Procedures are thin adapters over `modules/admin/index.ts` use cases
 * (ADR-0001) — no domain logic lives here; every `can()` check (ADR-0007)
 * happens inside the use case itself, using the caller's own
 * `identity.role_assignments` (`report_definition.manage`, `export.request`,
 * `export.download`, `dsar.orchestrate`, `audit_log.search` —
 * `packages/authz/src/rules.ts`). This file's own job is: validate input,
 * resolve the caller's `PolicySubject` from the *verified* session (never
 * from client input — same anti-corruption discipline as every other
 * router), and translate domain errors to `TRPCError` codes.
 *
 * There is no `orgAdminProcedure` builder in this codebase (see `../trpc.ts`
 * — only `publicProcedure`/`sessionProcedure`/`protectedProcedure` exist);
 * the API Contract Sketch's own `orgAdminProcedure` maps onto plain
 * `protectedProcedure` here, same as `gamificationRouter`'s absent
 * `adminProcedure` and `moderationRouter`'s absent `moderatorProcedure` —
 * the actual staff-only gate is each use case's own `can()` check, not the
 * procedure builder.
 *
 * Shaped per the API Contract Sketch in docs/ddd/admin-reporting.md, nested
 * exactly as sketched (`reportDefinition`/`exportJob`/`auditLog`
 * sub-routers under one `admin` mount) — a deliberate exception to
 * `moderationRouter`'s own "kept flat" precedent, which was about not
 * splitting into two separate *root*-level routers, not about avoiding
 * namespacing within one module's own router. One deliberate deviation
 * from the sketch's own file path: this router lives at
 * `server/api/routers/admin.ts` (`root.ts`'s existing mount point, matching
 * every other module — `identity`, `training`, `moderation`, ...) rather
 * than the sketch's illustrative `modules/admin/api/trpc/router.ts`, since
 * no module in this codebase keeps its own `api/` subfolder.
 *
 * `reportDefinition.list`/`.get` and `exportJob.list`/`.get` call
 * `listReportDefinitions`/`getReportDefinition`/`listExportJobs`/
 * `getExportJob` — thin, `org_admin`-gated reads this stage adds alongside
 * the router (no dedicated Key Use Case number in the doc; see those
 * files' own doc comments) so the sketch's own read procedures have a real
 * use case to adapt, same "a read needs a real function to call, not a raw
 * `ctx.prisma` query in the router" discipline every other router in this
 * codebase already follows.
 *
 * The sketch's two REST routes (`GET /api/v1/admin/exports/:exportJobId/
 * download` and `GET /api/v1/admin/exports/:exportJobId`) are NOT built
 * here — this router's own scope is the tRPC surface only. They live at
 * `app/api/v1/admin/exports/[exportJobId]/download/route.ts` and
 * `app/api/v1/admin/exports/[exportJobId]/route.ts`, session-authenticated
 * via `server/auth/session-person.ts`'s `resolveRequestPerson` rather than
 * going through this router, same "a stable, fetchable URL, not a tRPC
 * call" reasoning the API Contract Sketch gives for keeping them off this
 * `adminRouter` entirely.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  createReportDefinition,
  updateReportDefinition,
  listReportDefinitions,
  getReportDefinition,
  requestExportJob,
  orchestrateDsarRequest,
  listExportJobs,
  getExportJob,
  searchAuditLog,
  SUPPORTED_REPORT_TYPES,
  ExportJobDownloadExpiredError,
  ExportJobNotDownloadableError,
  ExportJobNotFoundError,
  ExternalServiceNotConfiguredError,
  ForbiddenActionError,
  InvalidExportJobStateError,
  ReportDefinitionNotActiveError,
  ReportDefinitionNotFoundError,
  UnsupportedReportTypeError,
} from "@/modules/admin";
import { router, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });

/** Builds the `PolicySubject` every privileged use case's `caller` argument needs, from the already-resolved session `Person` — same helper as every other router's own `callerSubject`. */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/admin/application/`) to the appropriate `TRPCError` code.
 * Centralized here, same shape as every other router's own `map*Error`.
 */
function mapAdminError(error: unknown): never {
  if (error instanceof ForbiddenActionError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (
    error instanceof ReportDefinitionNotFoundError ||
    error instanceof ExportJobNotFoundError
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof UnsupportedReportTypeError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof InvalidExportJobStateError) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (
    error instanceof ReportDefinitionNotActiveError ||
    error instanceof ExportJobNotDownloadableError ||
    error instanceof ExportJobDownloadExpiredError
  ) {
    // Not yet-ready / no-longer-valid preconditions — same "PRECONDITION_FAILED"
    // bucket `trainingRouter`'s own mapper uses for `VideoNotReadyError` et
    // al., including the REST-layer "410 Gone" case the API Contract
    // Sketch's own `GetExportDownloadUrl` describes (no literal 410 code in
    // tRPC's error union).
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  }
  if (error instanceof ExternalServiceNotConfiguredError) {
    // A missing R2 env var is an ops/config problem, not a bad request —
    // surface the exact missing-var message (this environment's documented
    // "throw a clear not-configured error" contract) rather than tRPC's
    // generic masked 500. Same precedent as `moderationRouter`'s/
    // `trainingRouter`'s own mappers.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  }
  throw error;
}

const reportDefinitionRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        reportType: z.enum(SUPPORTED_REPORT_TYPES),
        filters: z.record(z.string(), z.unknown()),
        groupBy: z.array(z.string()).optional(),
        hourlyValuationRateCents: z.number().int().positive().optional(),
        currency: z.string().length(3).optional(),
        outputFormats: z.array(z.enum(["csv", "pdf"])).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createReportDefinition(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: ulidSchema,
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
        groupBy: z.array(z.string()).optional(),
        hourlyValuationRateCents: z.number().int().positive().optional(),
        currency: z.string().length(3).optional(),
        outputFormats: z.array(z.enum(["csv", "pdf"])).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateReportDefinition(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),

  list: protectedProcedure
    .input(z.object({ activeOnly: z.boolean().default(true) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listReportDefinitions(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),

  get: protectedProcedure
    .input(z.object({ id: ulidSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getReportDefinition(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),
});

const exportJobRouter = router({
  request: protectedProcedure
    .input(
      z.object({
        type: z.enum(["grant_report", "custom"]),
        reportDefinitionId: ulidSchema.optional(),
        dateOverride: z.object({ fromDate: z.string(), toDate: z.string() }).optional(),
        outputFormat: z.enum(["csv", "pdf"]).optional(),
        customParams: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await requestExportJob(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),

  /**
   * `OrchestrateDsarRequest` (Key Use Case 4) — the admin-console trigger
   * for a DSAR filed through a channel other than self-service. Distinct
   * mutation from `request` above (see `orchestrateDsarRequest.ts`'s own
   * doc comment on why `RequestExportJob` deliberately does not accept
   * `type: 'dsar_export'` and branch internally).
   */
  orchestrateDsar: protectedProcedure
    .input(z.object({ subjectId: ulidSchema, operation: z.enum(["export", "erase"]) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await orchestrateDsarRequest(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),

  list: protectedProcedure
    .input(
      z.object({
        requestedByPersonId: ulidSchema.optional(),
        type: z.enum(["grant_report", "custom", "dsar_export"]).optional(),
        status: z.enum(["queued", "running", "completed", "failed"]).optional(),
        cursor: ulidSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listExportJobs(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),

  get: protectedProcedure
    .input(z.object({ id: ulidSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getExportJob(ctx.prisma, { caller: callerSubject(ctx.person), ...input });
      } catch (error) {
        mapAdminError(error);
      }
    }),
});

const auditLogRouter = router({
  /**
   * `SearchAuditLog` (Key Use Case 6) — `source: 'both'` returns a
   * platform-wide `admin.audit_log` summary UNIONED, in application code
   * (`searchAuditLog.ts` — never a cross-schema SQL join), with the fuller
   * `moderation.queryModerationHistory` detail; each row is tagged
   * `source: 'platform_summary' | 'moderation_detail'` so the admin console
   * can tell them apart.
   */
  search: protectedProcedure
    .input(
      z.object({
        actorId: ulidSchema.optional(),
        actionPrefix: z.string().optional(),
        resourceType: z.string().optional(),
        resourceId: ulidSchema.optional(),
        occurredAfter: z.string().datetime().optional(),
        occurredBefore: z.string().datetime().optional(),
        scopeId: ulidSchema.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        source: z.enum(["platform", "moderation_history", "both"]).default("both"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { source, occurredAfter, occurredBefore, ...rest } = input;
      try {
        return await searchAuditLog(ctx.prisma, {
          caller: callerSubject(ctx.person),
          source,
          filters: {
            ...rest,
            occurredAfter: occurredAfter ? new Date(occurredAfter) : undefined,
            occurredBefore: occurredBefore ? new Date(occurredBefore) : undefined,
          },
        });
      } catch (error) {
        mapAdminError(error);
      }
    }),
});

export const adminRouter = router({
  reportDefinition: reportDefinitionRouter,
  exportJob: exportJobRouter,
  auditLog: auditLogRouter,
});
