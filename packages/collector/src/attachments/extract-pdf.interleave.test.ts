// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-page PDF OCR interleave (#427): native text layer + OCR of image-only
 * pages, spliced together in page order. unpdf + the text joiner are mocked so
 * we can construct exact per-page native text (a real mixed PDF fixture would
 * be brittle); the OCR fn is a stub returning page-aligned `pageTexts`.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("unpdf", () => ({ extractTextItems: vi.fn() }));
vi.mock("./pdf-text-joiner.js", () => ({
  joinPageTextItems: vi.fn((p: { text?: string }) => p?.text ?? ""),
}));

import { extractTextItems } from "unpdf";
import { SyncError } from "@omnesis/types";
import { extractPdfText } from "./extract-pdf.js";
import type { OcrFn } from "@omnesis/core";

const mockedExtract = vi.mocked(extractTextItems);
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const pages = (...texts: string[]) =>
  ({ totalPages: texts.length, items: texts.map((t) => ({ text: t })) }) as never;

beforeEach(() => mockedExtract.mockReset());

describe("extractPdfText — per-page interleave", () => {
  test("interleaves native text with OCR of the image-only page, in order", async () => {
    mockedExtract.mockResolvedValue(
      pages("This is page one native text", "", "Another typed page three here"),
    );
    const ocr: OcrFn = vi.fn(async (_d, mime, opts) => {
      expect(mime).toBe("application/pdf");
      expect(opts?.pages).toEqual([2]); // only the image-only page is OCR'd
      return { text: "OCR PAGE TWO", pages: 3, pageTexts: ["", "OCR PAGE TWO", ""] };
    });
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res?.text).toBe(
      "This is page one native text\n\nOCR PAGE TWO\n\nAnother typed page three here",
    );
    expect(res?.pages).toBe(3);
    expect(res?.extra?.ocr).toBe(true);
    expect(res?.extra?.ocrPageCount).toBe(1);
    expect(ocr).toHaveBeenCalledOnce();
  });

  test("all-text PDF never calls OCR (no rasterization cost)", async () => {
    mockedExtract.mockResolvedValue(pages("page one has plenty of text", "page two also has text"));
    const ocr = vi.fn();
    const res = await extractPdfText(pdfBytes, { ocr: ocr as unknown as OcrFn });
    expect(ocr).not.toHaveBeenCalled();
    expect(res?.text).toBe("page one has plenty of text\n\npage two also has text");
    expect(res?.extra).toBeUndefined();
  });

  test("fully scanned PDF: every page is image-only → all OCR'd", async () => {
    mockedExtract.mockResolvedValue(pages("", ""));
    const ocr: OcrFn = vi.fn(async (_d, _m, opts) => {
      expect(opts?.pages).toEqual([1, 2]);
      return { text: "Alpha\n\nBeta", pages: 2, pageTexts: ["Alpha", "Beta"] };
    });
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res?.text).toBe("Alpha\n\nBeta");
    expect(res?.extra?.ocrPageCount).toBe(2);
  });

  test("fully scanned PDF with successful blank OCR returns a terminal no-text result", async () => {
    mockedExtract.mockResolvedValue(pages("", ""));
    const ocr: OcrFn = vi.fn(async () => ({
      text: "",
      pages: 2,
      pageTexts: ["", ""],
    }));
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res).toEqual({
      text: "",
      pages: 2,
      truncated: false,
      noText: true,
      extra: { ocr: true },
    });
  });

  test("image-only page but OCR not wired → native text only, empty page dropped", async () => {
    mockedExtract.mockResolvedValue(pages("only page one has real text", ""));
    const res = await extractPdfText(pdfBytes);
    expect(res?.text).toBe("only page one has real text");
    expect(res?.extra).toBeUndefined();
  });

  test("page-count mismatch (e.g. >50-page cap): appends OCR instead of mis-splicing", async () => {
    // unpdf sees 3 pages (2 image-only); the gateway returns pageTexts of a
    // different length (simulating the rasterization cap / library disagreement).
    mockedExtract.mockResolvedValue(pages("typed page one text here", "", ""));
    const ocr: OcrFn = vi.fn(async () => ({
      text: "OCR-OF-SCANNED-PAGES",
      pages: 2,
      pageTexts: ["only-one-entry"], // length 1 ≠ native length 3 → unsafe to splice
    }));
    const res = await extractPdfText(pdfBytes, { ocr });
    // Native text kept; OCR text appended as a block (not spliced by index).
    expect(res?.text).toBe("typed page one text here\n\nOCR-OF-SCANNED-PAGES");
    expect(res?.extra?.ocr).toBe(true);
  });

  test("blank OCR with a page-count mismatch is terminal when native text is also blank", async () => {
    mockedExtract.mockResolvedValue(pages("", "", ""));
    const ocr: OcrFn = vi.fn(async () => ({ text: "", pages: 2, pageTexts: ["", ""] }));
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res).toEqual({
      text: "",
      pages: 3,
      truncated: false,
      noText: true,
      extra: { ocr: true },
    });
  });

  test("OCR finds nothing on the image page → that page contributes nothing", async () => {
    mockedExtract.mockResolvedValue(pages("page one typed text here", ""));
    const ocr: OcrFn = vi.fn(async () => ({ text: "", pages: 2, pageTexts: ["", ""] }));
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res?.text).toBe("page one typed text here");
    expect(res?.extra).toBeUndefined(); // no page actually OCR'd → no ocr provenance
  });

  test("an OCR outage preserves native pages and marks sparse pages incomplete", async () => {
    mockedExtract.mockResolvedValue(pages("page one typed text here", ""));
    const ocr: OcrFn = vi.fn(async () => {
      throw new SyncError("transient", "OCR backend unreachable");
    });
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res?.text).toBe("page one typed text here");
    expect(res?.extra).toEqual({ ocrIncomplete: true });
  });

  test("unavailable OCR preserves native pages and marks sparse pages incomplete", async () => {
    mockedExtract.mockResolvedValue(pages("page one typed text here", ""));
    const ocr: OcrFn = vi.fn(async () => null);
    const res = await extractPdfText(pdfBytes, { ocr });
    expect(res?.text).toBe("page one typed text here");
    expect(res?.extra).toEqual({ ocrIncomplete: true });
  });
});
