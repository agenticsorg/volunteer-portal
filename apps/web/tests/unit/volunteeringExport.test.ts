import { describe, expect, it } from "vitest";
import type { ApprovedHourEntryRecord } from "@/modules/volunteering";
import { summarizeApprovedHours } from "@/server/volunteering/valuation";
import { buildApprovedHoursCsv } from "@/server/volunteering/csv";
import { buildApprovedHoursPdf, buildTextReportPdf } from "@/server/volunteering/pdf";

// Pure-function coverage for the `ExportApprovedHours` (Key Use Case 10)
// rendering helpers shared by `hourEntries.exportApproved` (tRPC) and
// `GET /api/v1/hour-entries/export` (REST) — no database, per ADR-0015's
// unit/integration split.

const record = (overrides: Partial<ApprovedHourEntryRecord> = {}): ApprovedHourEntryRecord => ({
  hourEntryId: "01H0000000000000000000001",
  personId: "01H0000000000000000000002",
  opportunityId: "01H0000000000000000000003",
  chapterId: "01H0000000000000000000004",
  shiftId: "01H0000000000000000000005",
  durationMinutes: 90,
  description: "Helped at the booth",
  approverPersonId: "01H0000000000000000000006",
  approvedAt: "2026-01-15T18:00:00.000Z",
  ...overrides,
});

describe("summarizeApprovedHours", () => {
  it("sums durationMinutes into hours, rounded to 2 decimals", () => {
    const records = [record({ durationMinutes: 90 }), record({ durationMinutes: 45 })];
    const summary = summarizeApprovedHours(records);
    expect(summary.totalHours).toBe(2.25);
  });

  it("totalValue is 0 when no hourlyRate is supplied", () => {
    const summary = summarizeApprovedHours([record({ durationMinutes: 60 })]);
    expect(summary.totalValue).toBe(0);
  });

  it("totalValue = totalHours * hourlyRate when supplied", () => {
    const summary = summarizeApprovedHours([record({ durationMinutes: 120 })], 20);
    expect(summary.totalHours).toBe(2);
    expect(summary.totalValue).toBe(40);
  });

  it("handles an empty record set", () => {
    expect(summarizeApprovedHours([], 20)).toEqual({ totalHours: 0, totalValue: 0 });
  });
});

describe("buildApprovedHoursCsv", () => {
  it("renders a header row plus one row per record", () => {
    const csv = buildApprovedHoursCsv([record()]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "hourEntryId,personId,opportunityId,chapterId,shiftId,durationMinutes,hours,description,approverPersonId,approvedAt",
    );
    expect(lines[1]).toContain("01H0000000000000000000001");
    expect(lines[1]).toContain("1.5"); // 90 minutes -> 1.5 hours
  });

  it("quotes fields containing commas, quotes, or newlines (RFC 4180)", () => {
    const csv = buildApprovedHoursCsv([record({ description: 'Helped, said "hi", and left\na note' })]);
    expect(csv).toContain('"Helped, said ""hi"", and left\na note"');
  });

  it("renders null fields as empty", () => {
    const csv = buildApprovedHoursCsv([record({ chapterId: null, shiftId: null, description: null })]);
    const dataLine = csv.trim().split("\r\n")[1];
    const fields = dataLine.split(",");
    // chapterId (index 3) and shiftId (index 4) are empty.
    expect(fields[3]).toBe("");
    expect(fields[4]).toBe("");
  });

  it("renders an empty export as just the header row", () => {
    const csv = buildApprovedHoursCsv([]);
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});

/** Minimal structural validation a hand-rolled PDF's byte layout is internally consistent, without a PDF-parsing dependency. */
function assertWellFormedPdf(pdf: Buffer) {
  const text = pdf.toString("latin1");
  expect(text.startsWith("%PDF-1.4")).toBe(true);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

  const startxrefMatch = text.match(/startxref\n(\d+)\n/);
  expect(startxrefMatch).not.toBeNull();
  const xrefOffset = Number(startxrefMatch![1]);
  expect(text.slice(xrefOffset, xrefOffset + 4)).toBe("xref");

  // Every offset in the xref table (skipping the free-object 0000000000
  // entry) must point at the start of an "N 0 obj" line.
  const objectOffsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  expect(objectOffsets.length).toBeGreaterThan(0);
  for (const offset of objectOffsets) {
    expect(text.slice(offset, offset + 20)).toMatch(/^\d+ 0 obj\n/);
  }
}

describe("buildTextReportPdf / buildApprovedHoursPdf", () => {
  it("produces a structurally valid single-page PDF for a short report", () => {
    const pdf = buildTextReportPdf(["Line one", "Line two"]);
    assertWellFormedPdf(pdf);
  });

  it("paginates across multiple pages for a long report", () => {
    const lines = Array.from({ length: 130 }, (_, i) => `Row ${i}`);
    const pdf = buildTextReportPdf(lines);
    const text = pdf.toString("latin1");
    assertWellFormedPdf(pdf);
    expect((text.match(/\/Type \/Page(?!s)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("escapes parentheses/backslashes in rendered text so the stream stays valid", () => {
    const pdf = buildTextReportPdf(["A (parenthetical) and a \\backslash\\"]);
    assertWellFormedPdf(pdf);
  });

  it("renders an approved-hours summary report", () => {
    const summary = summarizeApprovedHours([record({ durationMinutes: 120 })], 15);
    const pdf = buildApprovedHoursPdf([record({ durationMinutes: 120 })], summary, {
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      chapterId: "01H0000000000000000000004",
    });
    assertWellFormedPdf(pdf);
    expect(pdf.toString("latin1")).toContain("Approved Volunteer Hours");
  });

  it("renders a report body even for zero matching records", () => {
    const summary = summarizeApprovedHours([]);
    const pdf = buildApprovedHoursPdf([], summary, { fromDate: "2026-01-01", toDate: "2026-01-31" });
    assertWellFormedPdf(pdf);
    expect(pdf.toString("latin1")).toContain("no approved hour entries");
  });
});
