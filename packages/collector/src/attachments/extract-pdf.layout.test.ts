// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { extractPdfText } from "./extract-pdf.js";
import { truncatePdfText, PDF_LAYOUT_OPEN } from "./pdf-positioned-text.js";

type Run = [number, number, string];
const rows = (column: number): Run[] => [
  [50, 730, "Reservoir filtration readings"],
  [50, 705, "All measurements in liters"],
  [50, 680, "Metric"],
  [280, 680, "Interval"],
  [440, 680, "Cumulative"],
  [50, 655, "Recovered"],
  [column, 655, "37"],
  [50, 630, "Processed"],
  [280, 630, "12"],
  [440, 630, "84"],
];

/** Real positioned PDF text objects, no mocked extraction or model inference. */
function positionedPdf(pages: Run[][]): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = objects.length + 1;
    pageIds.push(pageId);
    const stream = page
      .map(([x, y, text]) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
        return `BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm (${escaped}) Tj ET`;
      })
      .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let result = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(result);
}

test("production PDF extraction distinguishes interval-only from cumulative-only amounts", async () => {
  const left = await extractPdfText(positionedPdf([rows(280)]));
  const right = await extractPdfText(positionedPdf([rows(440)]));
  expect(left?.text).toContain('x=280 "37"');
  expect(right?.text).toContain('x=440 "37"');
  expect(left?.text).not.toBe(right?.text);
  expect(right).toMatchObject({ pages: 1, truncated: false });
});
test("page-local layouts stay separate and output truncation keeps balanced fences", async () => {
  const bytes = positionedPdf([rows(280), rows(440)]);
  const full = await extractPdfText(bytes);
  expect(full?.pages).toBe(2);
  expect(full?.text.split(PDF_LAYOUT_OPEN)).toHaveLength(3);
  const partial = await extractPdfText(bytes, { maxTextLength: 240 });
  expect(partial?.truncated).toBe(true);
  expect(partial!.text.length).toBeLessThanOrEqual(240);
  expect(partial!.text.endsWith("\n~~~")).toBe(true);
});
test("global OCR/page assembly truncation never leaves a partial generated fence", () => {
  const text = `Intro\n${PDF_LAYOUT_OPEN}y=5: x=2 "short"\ny=4: x=2 "longer row"\n~~~\nTail\n${PDF_LAYOUT_OPEN}y=7: x=4 "second page"\n~~~`;
  for (let budget = 0; budget < text.length; budget++) {
    const output = truncatePdfText(text, budget);
    expect(output.length).toBeLessThanOrEqual(budget);
    if (output.includes(PDF_LAYOUT_OPEN))
      expect(output.split("\n").filter((line) => line === "~~~")).toHaveLength(
        output.split(PDF_LAYOUT_OPEN).length - 1,
      );
  }
});

test("output exhaustion never requests OCR for later native pages", async () => {
  const ocr = vi.fn();
  const result = await extractPdfText(positionedPdf([rows(280), rows(440)]), {
    maxTextLength: 120,
    ocr,
  });
  expect(result?.truncated).toBe(true);
  expect(ocr).not.toHaveBeenCalled();
});
test("position labels do not disguise a sparse native text layer", async () => {
  const tiny: Run[] = [
    [50, 700, "A"],
    [400, 700, "B"],
    [50, 680, "C"],
    [400, 680, "D"],
  ];
  const ocr = vi.fn(async () => ({
    text: "Recognized page content.",
    pages: 1,
    pageTexts: ["Recognized page content."],
  }));
  const result = await extractPdfText(positionedPdf([tiny]), { ocr });
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(result?.text).toBe("Recognized page content.");
});
test("an earlier scanned page still receives OCR when a later native page exhausts output", async () => {
  const ocr = vi.fn(async () => ({
    text: "Recognized first page.",
    pages: 2,
    pageTexts: ["Recognized first page.", ""],
  }));
  await extractPdfText(positionedPdf([[], rows(280)]), { maxTextLength: 140, ocr });
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(ocr).toHaveBeenCalledWith(expect.any(Uint8Array), "application/pdf", { pages: [1] });
});
