// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { extractTextItems } from "unpdf";
import pdf from "pdf-parse";
import { createLogger, type OcrFn, type OcrResult } from "@omnesis/core";
import { joinPageTextItems } from "./pdf-text-joiner.js";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:pdf");

/**
 * A page with fewer than this many native-text characters is treated as
 * image-only (a scanned page, or a page whose content is a picture) and is a
 * candidate for OCR. Typed pages comfortably clear it; this keeps us from
 * rasterizing + OCR'ing text-heavy pages (the expensive part).
 */
const PAGE_TEXT_MIN_CHARS = 15;

/**
 * Extract text from a PDF buffer, **per page**, interleaving the native text
 * layer with OCR of image-only pages (#427).
 *
 * For each page we take its native text (via unpdf's per-page items). Pages
 * that carry little or no native text are image-only — when an `ocr` fn is
 * wired, only those pages are rasterized + OCR'd on the gateway and their
 * recognized text is spliced back in at the right page position. So a mixed PDF
 * (typed pages + scanned pages, or a page that is a photo of text) yields one
 * document with everything searchable, in reading order.
 *
 * Returns null if the PDF can't be read (encrypted or corrupt) and OCR is
 * unavailable. Successful OCR with no recognized text returns `noText`.
 */
export async function extractPdfText(
  data: Uint8Array,
  opts?: { maxTextLength?: number; ocr?: OcrFn },
): Promise<ExtractionResult | null> {
  const maxLen = opts?.maxTextLength ?? 512_000;

  const perPage = await perPageNativeText(data);

  // unpdf couldn't read the page structure (encrypted / corrupt / non-PDF):
  // fall back to pdf-parse for any text layer, then whole-PDF OCR.
  if (!perPage) {
    const pdfParseResult = await tryPdfParse(data, maxLen);
    if (pdfParseResult) return pdfParseResult;
    if (opts?.ocr) {
      try {
        const ocrResult = await opts.ocr(data, "application/pdf");
        const text = ocrResult?.text.trim();
        if (text) {
          log.debug(`PDF OCR'd (whole): ${ocrResult?.pages ?? "?"} page(s), ${text.length} chars`);
          return assemble([text], ocrResult?.pages ?? 1, maxLen, ocrResult?.pages ?? 1);
        }
        if (ocrResult) return ocrNoText(ocrResult.pages);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Whole-PDF OCR failed, leaving attachment unextracted (non-fatal): ${msg}`);
      }
    }
    return null;
  }

  const sparse = perPage.flatMap((t, i) => (t.trim().length < PAGE_TEXT_MIN_CHARS ? [i] : []));

  // Every page has a real text layer, or OCR isn't wired → native text only.
  if (sparse.length === 0 || !opts?.ocr) {
    return assemble(perPage, perPage.length, maxLen, 0);
  }

  // OCR only the image-only pages; the gateway returns page-aligned `pageTexts`.
  let ocrResult: OcrResult | null;
  try {
    ocrResult = await opts.ocr(data, "application/pdf", { pages: sparse.map((i) => i + 1) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Sparse-page PDF OCR failed, keeping native text (non-fatal): ${msg}`);
    return assemble(perPage, perPage.length, maxLen, 0, true);
  }
  if (ocrResult === null) {
    return assemble(perPage, perPage.length, maxLen, 0, true);
  }
  const pageTexts = ocrResult?.pageTexts;

  // Splice OCR back per page ONLY when the gateway's rasterized page count
  // matches unpdf's native page count — otherwise positional alignment is
  // unsafe (e.g. the rasterizer's MAX_PAGES cap, or the two libraries
  // disagreeing on the page tree) and we'd risk attaching a page's OCR to the
  // WRONG native page. On a mismatch we keep the native text and append the
  // OCR'd text as a block: content stays searchable, just not interleaved.
  if (!Array.isArray(pageTexts) || pageTexts.length !== perPage.length) {
    const ocrText = (ocrResult?.text ?? (pageTexts ?? []).join("\n\n")).trim();
    if (!ocrText) {
      return assemble(perPage, perPage.length, maxLen, 0) ?? ocrNoText(perPage.length);
    }
    log.warn(
      `PDF page-count mismatch (native=${perPage.length}, ocr=${pageTexts?.length ?? 0}) — appending OCR text instead of per-page interleave`,
    );
    const nativeText = perPage
      .map((p) => p.trim())
      .filter(Boolean)
      .join("\n\n");
    return assemble([nativeText, ocrText], perPage.length, maxLen, 1);
  }

  let ocrPageCount = 0;
  const merged = perPage.map((native, i) => {
    if (native.trim().length >= PAGE_TEXT_MIN_CHARS) return native.trim();
    const ocrText = (pageTexts[i] ?? "").trim();
    if (ocrText) ocrPageCount++;
    return ocrText;
  });

  log.debug(
    `PDF extracted: ${perPage.length} pages, ${ocrPageCount} OCR'd (of ${sparse.length} image-only)`,
  );
  return assemble(merged, perPage.length, maxLen, ocrPageCount) ?? ocrNoText(perPage.length);
}

function ocrNoText(pages?: number): ExtractionResult {
  return { text: "", pages, truncated: false, noText: true, extra: { ocr: true } };
}

/**
 * Per-page native text via unpdf's structured per-run items (preserves spacing
 * / line breaks that the flat `extractText` glues together). Returns one entry
 * per page (empty string for an image-only page), or null when the PDF can't be
 * parsed at all (encrypted, corrupt) so the caller can fall back.
 */
async function perPageNativeText(data: Uint8Array): Promise<string[] | null> {
  try {
    const result = await extractTextItems(data);
    const pages = result.items ?? [];
    if (pages.length === 0) {
      log.debug(`unpdf: 0 pages (${data.length} bytes)`);
      return null;
    }
    return pages.map((pageItems) => joinPageTextItems(pageItems).trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("encrypt") || msg.includes("password")) {
      log.warn(`PDF is encrypted (${data.length} bytes): ${msg}`);
    } else {
      log.debug(`unpdf failed (${data.length} bytes): ${msg}, trying pdf-parse`);
    }
    return null;
  }
}

/**
 * Join per-page text into one document body, truncated to `maxLen`. Returns
 * null when there's no text at all. `ocrPageCount > 0` stamps OCR provenance.
 */
function assemble(
  pages: string[],
  totalPages: number,
  maxLen: number,
  ocrPageCount: number,
  ocrIncomplete = false,
): ExtractionResult | null {
  let text = pages
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!text) return null;
  let truncated = false;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen);
    truncated = true;
  }
  const extra =
    ocrPageCount > 0 || ocrIncomplete
      ? {
          ...(ocrPageCount > 0 ? { ocr: true, ocrPageCount } : {}),
          ...(ocrIncomplete ? { ocrIncomplete: true as const } : {}),
        }
      : undefined;
  return { text, pages: totalPages, truncated, ...(extra ? { extra } : {}) };
}

async function tryPdfParse(data: Uint8Array, maxLen: number): Promise<ExtractionResult | null> {
  try {
    const result = await pdf(Buffer.from(data));
    const pages = result.numpages ?? 0;

    if (!result.text?.trim()) {
      log.warn(
        `PDF has ${pages} pages but no extractable text (${data.length} bytes, likely scanned/image-only)`,
      );
      return null;
    }

    let text = result.text.trim();
    let truncated = false;

    if (text.length > maxLen) {
      text = text.slice(0, maxLen);
      truncated = true;
    }

    log.debug(`PDF extracted via pdf-parse: ${pages} pages, ${text.length} chars`);
    return { text, pages, truncated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("encrypt") || msg.includes("password")) {
      log.warn(`PDF is encrypted (${data.length} bytes): ${msg}`);
      return null;
    }
    log.warn(`PDF extraction failed (${data.length} bytes): ${msg}`);
    return null;
  }
}
