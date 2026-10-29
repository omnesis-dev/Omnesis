// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { readPdfPages } from "./pdf-pages.js";

describe("readPdfPages", () => {
  test("reads one entry per page, keeping the caller's bytes intact", async () => {
    const pdf = createTextPdf([
      "Fictional page one about kites",
      "Fictional page two about gliders",
    ]);
    const original = new Uint8Array(pdf);
    expect(await readPdfPages(pdf)).toEqual([
      "Fictional page one about kites",
      "Fictional page two about gliders",
    ]);
    expect(pdf).toEqual(original);
  });

  test("returns null for bytes that are not a PDF", async () => {
    expect(await readPdfPages(new TextEncoder().encode("not a pdf at all"))).toBeNull();
  });

  test("concurrent calls are answered each with their own file", async () => {
    const [a, b, c] = await Promise.all([
      readPdfPages(createTextPdf(["Fictional alpha"])),
      readPdfPages(new Uint8Array([1, 2, 3])),
      readPdfPages(createTextPdf(["Fictional gamma"])),
    ]);
    expect(a).toEqual(["Fictional alpha"]);
    expect(b).toBeNull();
    expect(c).toEqual(["Fictional gamma"]);
  });

  test("a file that runs out of time yields null and the next file gets a fresh parser", async () => {
    // Thousands of pages take the parser seconds; the limit is far shorter.
    const long = createTextPdf(Array.from({ length: 3000 }, (_, i) => `Fictional page ${i + 1}`));
    expect(await readPdfPages(long, { timeoutMs: 20 })).toBeNull();
    expect(await readPdfPages(createTextPdf(["Fictional next page"]))).toEqual([
      "Fictional next page",
    ]);
  });
});

/** A well-formed text PDF with one page per entry. */
function createTextPdf(pageTexts: string[]): Uint8Array {
  const fontObj = 3 + pageTexts.length * 2;
  const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`,
  ];
  for (const [i, text] of pageTexts.entries()) {
    const stream = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let content = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(content.length);
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = content.length;
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(content);
}
