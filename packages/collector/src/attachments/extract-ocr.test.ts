// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The OCR seam inside the shared attachment extractor: when an `OcrFn` is
 * wired, image attachments and scanned (text-layer-less) PDFs are recognized;
 * with no `ocr` fn the extractor behaves exactly as before.
 */

import { describe, test, expect, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { createAttachmentExtractor } from "./extract.js";
import type { OcrFn } from "@omnesis/core";

const enc = (s: string) => new TextEncoder().encode(s);

describe("createAttachmentExtractor — OCR", () => {
  test("routes image attachments to OCR and returns the recognized text", async () => {
    const ocr: OcrFn = vi.fn(async () => ({ text: "Whiteboard: ship Q3" }));
    const extract = createAttachmentExtractor({ ocr });
    const result = await extract(enc("PNGBYTES"), "image/png");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Whiteboard: ship Q3");
    expect(result!.extra?.ocr).toBe(true);
    expect(ocr).toHaveBeenCalledOnce();
  });

  test("handles an image MIME type with parameters", async () => {
    const ocr: OcrFn = vi.fn(async () => ({ text: "x" }));
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("i"), "image/jpeg; charset=binary")).not.toBeNull();
  });

  test("returns a terminal no-text result when OCR finds no text in an image", async () => {
    const ocr: OcrFn = async () => ({ text: "   " });
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("blank"), "image/png")).toEqual({
      text: "",
      pages: undefined,
      truncated: false,
      noText: true,
      extra: { ocr: true },
    });
  });

  test("returns null when OCR is unavailable for an image", async () => {
    const ocr: OcrFn = async () => null;
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("img"), "image/png")).toBeNull();
  });

  test("does not OCR images when no ocr fn is wired", async () => {
    const extract = createAttachmentExtractor();
    expect(await extract(enc("img"), "image/png")).toBeNull();
  });

  test("does not call the OCR fn when OCR is disabled by config", async () => {
    const ocr: OcrFn = vi.fn(async () => ({ text: "should not be called" }));
    const extract = createAttachmentExtractor({ ocr, ocrEnabled: () => false });
    expect(await extract(enc("img"), "image/png")).toBeNull();
    expect(ocr).not.toHaveBeenCalled();
  });

  test("falls back to OCR for a scanned PDF with no text layer", async () => {
    const ocr: OcrFn = vi.fn(async (_d, mime) => {
      expect(mime).toBe("application/pdf");
      return { text: "page one text", pages: 1 };
    });
    const extract = createAttachmentExtractor({ ocr });
    // Bytes unpdf/pdf-parse can't extract → the OCR fallback runs.
    const result = await extract(new Uint8Array([1, 2, 3]), "application/pdf");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("page one text");
    expect(result!.extra?.ocr).toBe(true);
    expect(ocr).toHaveBeenCalledOnce();
  });

  test("does not OCR a PDF when no ocr fn is wired (prior behavior)", async () => {
    const extract = createAttachmentExtractor();
    expect(await extract(new Uint8Array([1, 2, 3]), "application/pdf")).toBeNull();
  });

  test("does not call the OCR fn for scanned PDFs when OCR is disabled by config", async () => {
    const ocr: OcrFn = vi.fn(async () => ({ text: "should not be called", pages: 1 }));
    const extract = createAttachmentExtractor({ ocr, ocrEnabled: () => false });
    expect(await extract(new Uint8Array([1, 2, 3]), "application/pdf")).toBeNull();
    expect(ocr).not.toHaveBeenCalled();
  });

  test("a non-transient OCR error is non-fatal — returns null, never aborts the sync", async () => {
    // One bad attachment (e.g. an image the OCR model 500s on) must not throw
    // out of extraction and stall the whole source.
    const ocr: OcrFn = vi.fn(async () => {
      throw new Error("OCR backend error 500: cannot identify image file");
    });
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("svg-or-heic"), "image/svg+xml")).toBeNull();
    expect(ocr).toHaveBeenCalledOnce();
  });

  test("a transient OCR outage is non-fatal for images and scanned PDFs", async () => {
    const ocr: OcrFn = vi.fn(async () => {
      throw new SyncError("transient", "OCR backend unreachable");
    });
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("png"), "image/png")).toBeNull();
    expect(await extract(new Uint8Array([1, 2, 3]), "application/pdf")).toBeNull();
    expect(ocr).toHaveBeenCalledTimes(2);
  });
});
