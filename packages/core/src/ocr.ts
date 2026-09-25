// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OCR seam for the attachment pipeline.
 *
 * Images and image-only (scanned) PDFs carry text locked in pixels. The shared
 * attachment extractor (`extractAttachmentText`) is handed an `OcrFn` the same
 * way it already wraps `unpdf`/Office text extraction — it just becomes one
 * more way to turn binary attachment bytes into searchable text. The collector
 * implements the fn by forwarding the bytes to the gateway's `/inference/ocr`
 * endpoint, which runs the configured OCR model and returns the recognized
 * text. The model lives on the gateway (where the GPU and the always-on compute
 * are); the source only ever holds the bytes transiently — nothing is persisted.
 *
 * Returning `null` means OCR did not run — it is disabled, no OCR backend is
 * assigned, or the input could not be decoded. A successful recognition with
 * no text returns a non-null result whose `text` is empty, so callers can mark
 * the attachment terminal instead of retrying it as a processing failure.
 */

import type { OcrResult } from "./models/capabilities.js";

export type { OcrResult } from "./models/capabilities.js";

export type OcrFn = (
  data: Uint8Array,
  mimeType: string,
  opts?: {
    /** ISO-639-1 hint to bias language-specific recognition. */
    language?: string;
    /**
     * For a PDF: 1-based page numbers to OCR (the rest already have a native
     * text layer). Omitted = OCR every page. The result's `pageTexts` is
     * page-aligned so the caller can interleave with native text.
     */
    pages?: number[];
  },
) => Promise<OcrResult | null>;
