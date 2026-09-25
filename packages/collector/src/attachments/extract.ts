// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, type OcrFn, type AudioTranscribeFn } from "@omnesis/core";
import { extractPdfText } from "./extract-pdf.js";
import { extractTextContent } from "./extract-text.js";
import { extractOfficeText } from "./extract-office.js";
import { extractLegacyOfficeText } from "./extract-legacy-office.js";
import { extractOpenDocumentText } from "./extract-opendocument.js";
import { extractRtfText } from "./extract-rtf.js";
import { extractEmlText } from "./extract-eml.js";
import { extractPkpassText } from "./extract-pkpass.js";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:extract");

/** MIME types (without parameters) routed to OCR when an `OcrFn` is wired. */
function isImageMime(mimeType: string): boolean {
  return mimeType.split(";")[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

/** MIME types (without parameters) routed to STT when an `AudioTranscribeFn` is wired. */
function isAudioMime(mimeType: string): boolean {
  return mimeType.split(";")[0]?.trim().toLowerCase().startsWith("audio/") ?? false;
}

/** Map an OCR result onto the shared `ExtractionResult` shape. */
function ocrToExtraction(text: string, pages?: number): ExtractionResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return { text: "", pages, truncated: false, noText: true, extra: { ocr: true } };
  }
  return { text: trimmed, pages, truncated: false, extra: { ocr: true } };
}

/** Map a transcription result onto the shared `ExtractionResult` shape. */
function transcriptToExtraction(text: string): ExtractionResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { text: trimmed, truncated: false, extra: { transcribed: true } };
}

export interface AttachmentExtractorDeps {
  /**
   * OCR backend (forwards to the gateway). When present, image attachments and
   * scanned/image-only PDF pages are recognized; when absent, images aren't
   * extracted and scanned PDFs return null exactly as before.
   */
  ocr?: OcrFn;
  /**
   * Runtime gate for OCR. The collector can always reach the gateway OCR route,
   * but it should only call it when an OCR assignment is configured.
   */
  ocrEnabled?: () => boolean;
  /**
   * Speech-to-text backend (forwards to the gateway). When present, audio
   * attachments on document sources (email) are transcribed into a child doc;
   * when absent, audio isn't extracted. Conversation sources never route audio
   * here — they transcribe inline (their audio types stay out of the allow-list
   * unless this dep AND the source's `includeAudioTypes` opt in).
   */
  transcribe?: AudioTranscribeFn;
}

/**
 * Build the shared attachment text extractor. OCR and STT are injected here —
 * closed over — rather than handed to each provider, so the `(bytes, mime) →
 * text` contract every source already calls is unchanged and recognition /
 * transcription happen transparently inside it (no per-source code).
 */
export function createAttachmentExtractor(deps: AttachmentExtractorDeps = {}) {
  const { transcribe } = deps;
  // OCR is optional enrichment: no per-file failure may abort the source's
  // primary document page or hold its cursor behind one attachment. Providers
  // with persistent media retry state receive null and reprocess later;
  // cursor-only providers advance and recover OCR only if the input is later
  // revisited or manually resynced. Raw non-OCR extractor/transcriber failures
  // keep their existing typed retry behavior at the provider boundary.
  const ocr: OcrFn | undefined = deps.ocr
    ? async (data, mime, opts) => {
        if (deps.ocrEnabled && !deps.ocrEnabled()) return null;
        try {
          return await deps.ocr!(data, mime, opts);
        } catch (err) {
          // PDF extraction can preserve its native text and stamp partial OCR
          // provenance, so let that layer classify the failure itself.
          if (mime === "application/pdf") throw err;
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`OCR failed for ${mime}, leaving attachment unextracted (non-fatal): ${msg}`);
          return null;
        }
      }
    : undefined;

  /**
   * Extract text from an attachment by MIME type.
   * Returns null if the type is unsupported or extraction fails.
   *
   * Identical bytes arriving again (the same file attached to a second
   * message) are extracted from scratch — see #62 for a raw-bytes-hash
   * cache and why it is deferred.
   */
  return async function extractAttachmentText(
    data: Uint8Array,
    mimeType: string,
    opts?: { maxTextLength?: number },
  ): Promise<ExtractionResult | null> {
    const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType;
    switch (base) {
      case "application/pdf":
        // Native text first; the extractor falls back to OCR per page for
        // scanned / image-only PDFs when an `ocr` fn is available.
        return extractPdfText(data, { ...opts, ocr });

      // Office documents
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        return extractOfficeText(data, base, opts);

      // Legacy Office documents
      case "application/msword":
      case "application/vnd.ms-excel":
      case "application/x-msexcel":
      case "application/vnd.ms-powerpoint":
        return extractLegacyOfficeText(data, base, opts);

      // OpenDocument documents
      case "application/vnd.oasis.opendocument.text":
      case "application/vnd.oasis.opendocument.spreadsheet":
      case "application/vnd.oasis.opendocument.presentation":
        return extractOpenDocumentText(data, base, opts);

      case "application/rtf":
      case "text/rtf":
        return extractRtfText(data, opts);

      // Text-based formats
      case "text/plain":
      case "text/csv":
      case "text/html":
      case "text/markdown":
      case "application/json":
      case "text/calendar":
        return extractTextContent(data, base, opts);

      // Email messages
      case "message/rfc822":
        return extractEmlText(data, opts);

      // Apple Wallet passes (boarding passes, tickets, loyalty cards). A
      // `.pkpass` is a signed zip; `.pkpasses` is a bundle of several. We parse
      // the JSON payload into searchable text.
      case "application/vnd.apple.pkpass":
      case "application/vnd.apple.pkpasses":
        return extractPkpassText(data, base, opts);

      // Unsupported
      case "application/vnd.ms-outlook":
        log.debug(`MSG format not yet supported (${data.length} bytes)`);
        return null;

      default:
        // Images go to OCR when an OCR backend is wired. When it isn't,
        // `ocr` is unset (or returns null) and we fall through to `return null`
        // → the attachment is recorded as extraction-failed and retried on a
        // later resync once a backend is configured.
        if (ocr && isImageMime(base)) {
          const result = await ocr(data, base);
          if (!result) return null;
          return ocrToExtraction(result.text, result.pages);
        }
        // Audio goes to STT when it's wired (the allow-list only admits audio
        // types for a document source with `includeAudioTypes`, so we never
        // reach here for a conversation source — those transcribe inline).
        if (transcribe && isAudioMime(base)) {
          const result = await transcribe(data, base);
          if (!result) return null;
          return transcriptToExtraction(result.text);
        }
        return null;
    }
  };
}

/**
 * The shared attachment extractor with OCR off. Used by callers that don't wire
 * OCR (and as a stable import for tests). The collector builds an OCR-enabled
 * extractor via `createAttachmentExtractor({ ocr })`, passing the gateway's OCR
 * function.
 */
export const extractAttachmentText = createAttachmentExtractor();
