import { describe, expect, it } from "vitest";
import { buildCertificatePdf } from "@/modules/training";

describe("buildCertificatePdf", () => {
  const input = {
    certificateNumber: "AGF-2026-000482",
    recipientDisplayName: "Ada Lovelace",
    courseTitle: "Safety Onboarding",
    issuedAtIso: "2026-05-24T00:00:00.000Z",
  };

  it("renders a well-formed PDF 1.4 document (header, objects, xref, trailer)", () => {
    const bytes = buildCertificatePdf(input);
    const text = bytes.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Type /Page");
    expect(text).toContain("xref");
    expect(text).toContain("trailer");
    expect(text.trim().endsWith("%%EOF")).toBe(true);
  });

  it("embeds the certificate number, recipient name, and course title as literal PDF text", () => {
    const bytes = buildCertificatePdf(input);
    const text = bytes.toString("latin1");
    expect(text).toContain("AGF-2026-000482");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Safety Onboarding");
  });

  it("escapes PDF-special characters in text (parentheses, backslashes)", () => {
    const bytes = buildCertificatePdf({ ...input, recipientDisplayName: "O'Brien (Team \\ Lead)" });
    const text = bytes.toString("latin1");
    expect(text).toContain("O'Brien \\(Team \\\\ Lead\\)");
  });

  it("the xref byte offsets point at the start of each numbered object", () => {
    const bytes = buildCertificatePdf(input);
    const text = bytes.toString("latin1");
    const xrefStart = text.indexOf("xref");
    const xrefBlock = text.slice(xrefStart, text.indexOf("trailer"));
    const offsetLines = xrefBlock
      .split("\n")
      .slice(2) // skip "xref" and the "0 N" count line
      .filter((line) => line.trim().length > 0);

    for (const line of offsetLines) {
      const offset = Number(line.slice(0, 10));
      if (offset === 0) continue; // the free-list head entry
      const chunk = text.slice(offset, offset + 20);
      expect(chunk).toMatch(/^\d+ 0 obj/);
    }
  });
});
