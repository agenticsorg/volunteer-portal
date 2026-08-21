/**
 * Minimal, dependency-free single-page certificate PDF rendering —
 * IssueCertificate's `templateVersion: "v1"` layout. Same rationale as
 * `apps/web/src/server/volunteering/pdf.ts`'s own header: no PDF library
 * exists anywhere in this monorepo's dependency tree, and this phase's
 * brief is explicit that nothing gets stubbed for a missing external
 * dependency, so this hand-writes a genuinely valid PDF 1.4 document
 * directly against the PDF object/xref format. Kept as `training`'s own
 * small helper rather than importing `volunteering`'s (which renders
 * multi-page tabular reports, a different shape) — same "each bounded
 * context owns its own small file-rendering helper" precedent as
 * `server/dsar/signing.ts` vs. `server/volunteering/signing.ts`.
 */
const PAGE_WIDTH = 792; // US Letter landscape, points
const PAGE_HEIGHT = 612;

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

interface CertificateLine {
  text: string;
  fontSize: number;
  y: number;
}

function centeredLine(text: string, fontSize: number, y: number): CertificateLine {
  return { text, fontSize, y };
}

export interface CertificateTemplateInput {
  certificateNumber: string;
  recipientDisplayName: string;
  courseTitle: string;
  issuedAtIso: string;
}

/** Renders `input` as a one-page landscape certificate PDF. Returns raw PDF bytes. */
export function buildCertificatePdf(input: CertificateTemplateInput): Buffer {
  const lines: CertificateLine[] = [
    centeredLine("Certificate of Completion", 28, PAGE_HEIGHT - 160),
    centeredLine("This certifies that", 14, PAGE_HEIGHT - 220),
    centeredLine(input.recipientDisplayName, 22, PAGE_HEIGHT - 260),
    centeredLine("has completed the course", 14, PAGE_HEIGHT - 300),
    centeredLine(input.courseTitle, 18, PAGE_HEIGHT - 340),
    centeredLine(`Certificate No. ${input.certificateNumber}`, 11, PAGE_HEIGHT - 400),
    centeredLine(`Issued ${input.issuedAtIso}`, 11, PAGE_HEIGHT - 420),
  ];

  // Object numbering: 1 = Catalog, 2 = Pages, 3 = Font, 4 = Page, 5 = Content stream.
  const contentOps = lines
    .map((line) => {
      // Rough horizontal centering: Helvetica's average glyph width is
      // ~0.5 * fontSize for this template's mixed-case text — precise
      // enough for a certificate, not a general-purpose text layout engine.
      const approxWidth = line.text.length * line.fontSize * 0.5;
      const x = Math.max(36, (PAGE_WIDTH - approxWidth) / 2);
      return `BT /F1 ${line.fontSize} Tf ${x.toFixed(2)} ${line.y} Td (${escapePdfText(line.text)}) Tj ET`;
    })
    .join("\n");

  const objectBodies = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [4 0 R] /Count 1 >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${Buffer.byteLength(contentOps, "latin1")} >>\nstream\n${contentOps}\nendstream`,
  ];

  const chunks: string[] = ["%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"];
  const offsets: number[] = [];
  let cursor = Buffer.byteLength(chunks[0], "latin1");

  for (let i = 0; i < objectBodies.length; i++) {
    offsets.push(cursor);
    const objText = `${i + 1} 0 obj\n${objectBodies[i]}\nendobj\n`;
    chunks.push(objText);
    cursor += Buffer.byteLength(objText, "latin1");
  }

  const xrefOffset = cursor;
  const xrefLines = [
    "xref",
    `0 ${objectBodies.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
  ];
  const trailer = ["trailer", `<< /Size ${objectBodies.length + 1} /Root 1 0 R >>`, "startxref", `${xrefOffset}`, "%%EOF"];

  chunks.push(xrefLines.join("\n") + "\n");
  chunks.push(trailer.join("\n") + "\n");

  return Buffer.from(chunks.join(""), "latin1");
}
