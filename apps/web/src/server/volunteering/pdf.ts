import type { ApprovedHourEntryRecord } from "@/modules/volunteering";
import type { ApprovedHoursSummary } from "./valuation";

/**
 * Minimal, dependency-free PDF rendering for `ExportApprovedHours` (Key Use
 * Case 10) — the `format=pdf` half of `GET /api/v1/hour-entries/export`'s
 * documented `format=csv|pdf` contract.
 *
 * No PDF library exists anywhere in this monorepo's dependency tree (the
 * Cloudflare Stream/R2 PDF work in the DDD docs is Training/Certificates,
 * a later phase), and this phase's own brief is explicit that nothing
 * gets stubbed for a missing external dependency — so this hand-writes a
 * genuinely valid, spec-conformant PDF 1.4 document (one Catalog, one
 * Pages tree, a page per ~50 rows, a single base-14 Helvetica font — no
 * font embedding needed since Helvetica is guaranteed present in every
 * PDF-1.4-conformant reader) directly against the PDF object/xref format,
 * rather than pulling in a new third-party dependency for one report.
 */
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const FONT_SIZE = 10;
const LINE_HEIGHT = 14;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT);

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [[]];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function contentStreamFor(lines: readonly string[]): string {
  const top = PAGE_HEIGHT - MARGIN;
  const body = lines
    .map((line) => `(${escapePdfText(line)}) Tj T*`)
    .join("\n");
  return `BT\n/F1 ${FONT_SIZE} Tf\n${LINE_HEIGHT} TL\n${MARGIN} ${top} Td\n${body}\nET`;
}

/**
 * Renders `lines` (already laid out — one string per printed line, no
 * embedded newlines) as a simple, paginated, monospaced-feel Helvetica
 * report. Returns the raw PDF bytes.
 */
export function buildTextReportPdf(lines: readonly string[]): Buffer {
  const pages = chunk(lines, LINES_PER_PAGE);
  const pageCount = pages.length;

  // Object numbering: 1 = Catalog, 2 = Pages, 3 = Font, then for each page
  // i (0-indexed): page object = 4 + 2i, content-stream object = 5 + 2i.
  const pageObjNums = pages.map((_, i) => 4 + 2 * i);
  const contentObjNums = pages.map((_, i) => 5 + 2 * i);
  const totalObjects = 3 + pageCount * 2;

  const objectBodies: string[] = new Array(totalObjects);

  objectBodies[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objectBodies[1] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objectBodies[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  pages.forEach((pageLines, i) => {
    const pageObjNum = pageObjNums[i];
    const contentObjNum = contentObjNums[i];
    objectBodies[pageObjNum - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>`;

    const stream = contentStreamFor(pageLines);
    const streamBytes = Buffer.byteLength(stream, "latin1");
    objectBodies[contentObjNum - 1] =
      `<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream`;
  });

  const chunks: string[] = ["%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"];
  const offsets: number[] = [];
  let cursor = Buffer.byteLength(chunks[0], "latin1");

  for (let i = 0; i < totalObjects; i++) {
    offsets.push(cursor);
    const objText = `${i + 1} 0 obj\n${objectBodies[i]}\nendobj\n`;
    chunks.push(objText);
    cursor += Buffer.byteLength(objText, "latin1");
  }

  const xrefOffset = cursor;
  const xrefLines = [
    "xref",
    `0 ${totalObjects + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
  ];
  const trailer = [
    "trailer",
    `<< /Size ${totalObjects + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefOffset}`,
    "%%EOF",
  ];

  chunks.push(xrefLines.join("\n") + "\n");
  chunks.push(trailer.join("\n") + "\n");

  return Buffer.from(chunks.join(""), "latin1");
}

/**
 * Grant-report-shaped PDF for a filtered set of approved `HourEntry` rows —
 * same underlying data as `csv.ts`'s `buildApprovedHoursCsv`, laid out as a
 * human-readable report instead of a raw data extract.
 */
export function buildApprovedHoursPdf(
  records: readonly ApprovedHourEntryRecord[],
  summary: ApprovedHoursSummary,
  filters: { fromDate: string; toDate: string; chapterId?: string; opportunityId?: string },
): Buffer {
  const lines: string[] = [
    "Approved Volunteer Hours — Grant Report",
    `Date range: ${filters.fromDate} to ${filters.toDate}`,
    filters.chapterId ? `Chapter: ${filters.chapterId}` : "Chapter: (all)",
    filters.opportunityId ? `Opportunity: ${filters.opportunityId}` : "Opportunity: (all)",
    `Total entries: ${records.length}   Total hours: ${summary.totalHours}   Total value: ${summary.totalValue}`,
    "",
    "Hour Entry ID / Person / Opportunity / Hours / Approved At",
    "-".repeat(78),
    ...records.map((record) => {
      const hours = Math.round((record.durationMinutes / 60) * 100) / 100;
      return `${record.hourEntryId}  ${record.personId}  ${record.opportunityId}  ${hours}h  ${record.approvedAt}`;
    }),
  ];
  if (records.length === 0) {
    lines.push("(no approved hour entries match this filter)");
  }
  return buildTextReportPdf(lines);
}
