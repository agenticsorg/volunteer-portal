import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { getPersonSummary } from "@/modules/identity";
import { queryApprovedHours } from "@/modules/volunteering";
import { buildTextReportPdf } from "@/server/volunteering/pdf";
import { ExportJobNotFoundError, InvalidExportJobStateError, UnsupportedReportTypeError } from "../domain/errors";
import { isSupportedReportType } from "../domain/reportTypes";
import { cloudflareR2Adapter } from "../infra/cloudflareR2Client";
import type { GrantReportExportParams } from "./requestExportJob";

/** ADR-0011's grant-report R2 lifecycle rule: "2 years per ADR-0011's lifecycle rule." */
const GRANT_REPORT_EXPIRY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export interface ProcessExportJobResult {
  status: "completed" | "failed";
}

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

interface GrantReportRow {
  personId: string;
  personName: string;
  chapterId: string | null;
  opportunityId: string;
  hours: number;
  valuationCents: number;
  approvedAt: string;
}

const CSV_HEADER = ["personId", "personName", "chapterId", "opportunityId", "hours", "valuation", "approvedAt"];

function renderCsv(rows: readonly GrantReportRow[], currency: string): Buffer {
  const lines = [
    CSV_HEADER.join(","),
    ...rows.map((row) =>
      [
        row.personId,
        escapeCsvField(row.personName),
        row.chapterId ?? "",
        row.opportunityId,
        row.hours.toFixed(2),
        formatCents(row.valuationCents, currency),
        row.approvedAt,
      ].join(","),
    ),
  ];
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

function renderPdfLines(rows: readonly GrantReportRow[], currency: string, totalCents: number): readonly string[] {
  const lines = [
    "Grant Report — Approved Hours Summary",
    `Rows: ${rows.length}    Total valuation: ${formatCents(totalCents, currency)}`,
    "",
    CSV_HEADER.join("  "),
    ...rows.map(
      (row) =>
        `${row.personId}  ${row.personName}  ${row.chapterId ?? "-"}  ${row.opportunityId}  ${row.hours.toFixed(2)}h  ${formatCents(row.valuationCents, currency)}  ${row.approvedAt}`,
    ),
  ];
  return lines;
}

/**
 * `ProcessExportJob` (docs/ddd/admin-reporting.md, Key Use Case 5,
 * `grant_report`/`custom` only — `dsar_export` is driven entirely by
 * `orchestrateDsarRequest.ts`/`consumeIdentityDsarEvents.ts` instead, per
 * that Key Use Case's own scope note).
 *
 * Reads `volunteering.queryApprovedHours` (Phase 3) through
 * `modules/volunteering`'s own `index.ts` barrel — never a direct
 * cross-schema query — and `identity.getPersonSummary` for the
 * volunteer-name enrichment `queryApprovedHours`'s own doc comment
 * deliberately leaves for "a much later Admin & Reporting phase" (this
 * one). Uploads the rendered file through this module's own R2 adapter
 * boundary (`infra/cloudflareR2Client.ts`).
 *
 * Deliberately never throws: every failure path (an unsupported
 * `reportType`, an R2 upload error not configured in this environment, ...)
 * is caught, recorded on the job row (`status = 'failed'`, `errorMessage`),
 * and reflected in this function's own return value — see
 * `requestExportJob.ts`'s own doc comment for why its caller relies on
 * that never-throws guarantee instead of wrapping this call in its own
 * try/catch. Matches the doc's own framing: "the job is not retried
 * automatically ... a report generation failure usually needs a human
 * look," i.e. a `failed` `ExportJob` row is itself the correct, complete
 * outcome, not a still-unhandled error.
 */
export async function processExportJob(prisma: PrismaClient, exportJobId: string): Promise<ProcessExportJobResult> {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (!job) {
    throw new ExportJobNotFoundError(exportJobId);
  }
  if (job.status !== "queued") {
    throw new InvalidExportJobStateError(exportJobId, job.status, "process");
  }

  await prisma.exportJob.update({ where: { id: exportJobId }, data: { status: "running", startedAt: new Date() } });

  try {
    if (job.type !== "grant_report") {
      // `type: 'custom'` has no generator registered this phase (see
      // `domain/reportTypes.ts`'s own header comment on scope) — a `custom`
      // `ExportJob` still gets a real, honest `failed` outcome rather than
      // hanging at `running` forever or silently faking a result.
      throw new UnsupportedReportTypeError(`(export_job.type = "${job.type}")`);
    }

    const params = job.params as unknown as GrantReportExportParams;
    if (!isSupportedReportType(params.reportType)) {
      throw new UnsupportedReportTypeError(params.reportType);
    }

    const hourEntries = await queryApprovedHours(prisma, {
      chapterId: params.chapterIds?.[0],
      fromDate: new Date(params.fromDate),
      toDate: new Date(params.toDate),
    });

    const uniquePersonIds = [...new Set(hourEntries.map((entry) => entry.personId))];
    const personSummaries = new Map<string, string>();
    for (const personId of uniquePersonIds) {
      const summary = await getPersonSummary(prisma, personId);
      personSummaries.set(personId, summary?.displayName ?? "Unknown");
    }

    const rows: GrantReportRow[] = hourEntries.map((entry) => {
      const hours = entry.durationMinutes / 60;
      return {
        personId: entry.personId,
        personName: personSummaries.get(entry.personId) ?? "Unknown",
        chapterId: entry.chapterId,
        opportunityId: entry.opportunityId,
        hours,
        // Cents math throughout — never floating-point dollars — same
        // "integer cents" discipline `hourly_valuation_rate_cents` itself
        // is stored in.
        valuationCents: Math.round(hours * params.hourlyValuationRateCents),
        approvedAt: entry.approvedAt,
      };
    });
    const totalValuationCents = rows.reduce((sum, row) => sum + row.valuationCents, 0);

    const chapterKeySegment = params.chapterIds?.[0] ?? "all-chapters";
    const key = `exports/grant-reports/${chapterKeySegment}/${exportJobId}.${params.outputFormat}`;

    const bytes =
      params.outputFormat === "csv"
        ? renderCsv(rows, params.currency)
        : buildTextReportPdf(renderPdfLines(rows, params.currency, totalValuationCents));
    const contentType = params.outputFormat === "csv" ? "text/csv" : "application/pdf";

    await cloudflareR2Adapter.uploadExportFile(key, bytes, contentType);

    const now = new Date();
    const outputFileExpiresAt = new Date(now.getTime() + GRANT_REPORT_EXPIRY_MS);

    await prisma.$transaction(async (tx) => {
      await tx.exportJob.update({
        where: { id: exportJobId },
        data: {
          status: "completed",
          completedAt: now,
          rowCount: rows.length,
          outputFileKey: key,
          outputFileFormat: params.outputFormat,
          outputFileExpiresAt,
        },
      });

      await tx.adminDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "ExportJob",
          aggregateId: exportJobId,
          eventType: "ExportJobCompleted",
          payload: {
            exportJobId,
            type: job.type,
            requestedByPersonId: job.requestedByPersonId,
            outputFileKey: key,
            outputFileExpiresAt: outputFileExpiresAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(tx.adminDomainEvent, {
        actorId: job.requestedByPersonId,
        actorType: "user",
        action: "export.completed",
        resourceType: "export_job",
        resourceId: exportJobId,
        metadata: { type: job.type, rowCount: rows.length, outputFileKey: key },
      });
    });

    return { status: "completed" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await prisma.$transaction(async (tx) => {
      await tx.exportJob.update({
        where: { id: exportJobId },
        data: { status: "failed", errorMessage },
      });

      await tx.adminDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "ExportJob",
          aggregateId: exportJobId,
          eventType: "ExportJobFailed",
          payload: {
            exportJobId,
            type: job.type,
            requestedByPersonId: job.requestedByPersonId,
            errorMessage,
          } satisfies Prisma.InputJsonValue,
        },
      });
    });

    return { status: "failed" };
  }
}
