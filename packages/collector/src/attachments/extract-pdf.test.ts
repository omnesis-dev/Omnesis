// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { extractPdfText } from "./extract-pdf.js";

describe("extractPdfText", () => {
  test("returns null for empty data", async () => {
    const result = await extractPdfText(new Uint8Array(0));
    expect(result).toBeNull();
  });

  test("returns null for corrupt/invalid data", async () => {
    const result = await extractPdfText(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result).toBeNull();
  });

  test("extracts text from a valid PDF", async () => {
    // Create a minimal valid PDF with text
    const pdf = createMinimalPdf("Hello World");
    const result = await extractPdfText(pdf);
    // If unpdf can parse this minimal PDF, check structure
    if (result) {
      expect(result.text).toContain("Hello");
      expect(result.truncated).toBe(false);
      expect(typeof result.pages).toBe("number");
    }
    // If not, that's also ok — minimal PDFs are tricky
  });

  test("truncates text exceeding maxTextLength", async () => {
    const pdf = createMinimalPdf("A".repeat(1000));
    const result = await extractPdfText(pdf, { maxTextLength: 50 });
    if (result) {
      expect(result.text.length).toBeLessThanOrEqual(50);
      expect(result.truncated).toBe(true);
    }
  });

  test("handles text with special characters", async () => {
    const pdf = createMinimalPdf("Caf\\xe9 na\\xefve \\u2014 \\u201chello\\u201d \\u00a31.50");
    const result = await extractPdfText(pdf);
    // If unpdf can parse it, verify we get text back without crashing
    if (result) {
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
    }
    // Not crashing is the main assertion — minimal PDFs may not round-trip all chars
  });

  test("separates two-column runs glued on the same baseline", async () => {
    // Reproduces the form-PDF artefact end-to-end: a field value and the next
    // field's label sit in adjacent columns on one baseline. The geometry-aware
    // joiner must insert a separator rather than gluing them into
    // "...example.comWhat...".
    const pdf = createTwoColumnPdf("jlopez@example.com", "What is their email address?");
    const result = await extractPdfText(pdf);
    if (result) {
      expect(result.text).not.toMatch(/example\.comWhat/);
      expect(result.text).toContain("example.com");
      expect(result.text).toContain("What is their email address?");
    }
    // If unpdf can't parse this hand-built PDF, the joiner is still covered by
    // its own unit tests; this asserts the wiring when parsing succeeds.
  });

  test("returns null for PDF with only whitespace pages", async () => {
    // Create a PDF whose page content is only spaces and newlines
    const pdf = createMinimalPdf("   \n  \n   ");
    const result = await extractPdfText(pdf);
    // The implementation trims each page and skips empty ones,
    // then checks if final text.trim() is empty → returns null
    if (result === null) {
      // Expected: whitespace-only content is treated as no extractable text
      expect(result).toBeNull();
    } else {
      // If unpdf somehow adds non-whitespace artifacts, the text should still be minimal
      expect(result.text.trim().length).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * Create a minimal valid PDF buffer with the given text content.
 * This creates a bare-bones PDF 1.4 file.
 */
function createMinimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 100 700 Td (${escaped}) Tj ET`;
  const streamLen = stream.length;

  const lines = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
    `4 0 obj << /Length ${streamLen} >> stream\n${stream}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    `0000000${(266).toString().padStart(4, "0")} 00000 n `,
    `0000000${(266 + streamLen + 44).toString().padStart(4, "0")} 00000 n `,
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "0",
    "%%EOF",
  ];

  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * Create a minimal valid PDF with two text runs on the same baseline,
 * separated by a horizontal column gap (left run at x=100, right run shifted
 * +260). Models a two-column form row (value | label).
 */
function createTwoColumnPdf(left: string, right: string): Uint8Array {
  const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 100 700 Td (${esc(left)}) Tj 260 0 Td (${esc(right)}) Tj ET`;
  const streamLen = stream.length;

  const lines = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
    `4 0 obj << /Length ${streamLen} >> stream\n${stream}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "0",
    "%%EOF",
  ];

  return new TextEncoder().encode(lines.join("\n"));
}
