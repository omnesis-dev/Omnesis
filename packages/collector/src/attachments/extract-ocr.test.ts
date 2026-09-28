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

  test("an image skipped while OCR is paused is reported as deferred to a caller that asks", async () => {
    const ocr: OcrFn = async () => {
      throw new SyncError("transient", "OCR requests paused after a request timeout", {
        retryAfterMs: 60_000,
      });
    };
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("png"), "image/png", { reportDeferred: true })).toEqual({
      text: "",
      truncated: false,
      deferred: true,
    });
    // A caller that does not ask gets the null it always did.
    expect(await extract(enc("png"), "image/png")).toBeNull();
  });

  test("an image whose OCR timed out is a failure, not a deferral", async () => {
    const ocr: OcrFn = async () => {
      throw new SyncError("transient", "OCR request timed out after 30000ms");
    };
    const extract = createAttachmentExtractor({ ocr });
    expect(await extract(enc("png"), "image/png", { reportDeferred: true })).toBeNull();
  });
});

describe("createAttachmentExtractor — text charset", () => {
  test("a Latin-1 text attachment is read in the charset its type declares", async () => {
    const extract = createAttachmentExtractor();
    const result = await extract(
      Buffer.from("Compte rendu : réunion à 14h", "latin1"),
      "text/plain; charset=ISO-8859-1",
    );
    expect(result!.text).toBe("Compte rendu : réunion à 14h");
  });

  test("a text attachment with no charset that is not UTF-8 reads as windows-1252", async () => {
    const extract = createAttachmentExtractor();
    const result = await extract(Buffer.from("Café crème", "latin1"), "text/plain");
    expect(result!.text).toBe("Café crème");
  });
});
