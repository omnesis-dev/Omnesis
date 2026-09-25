// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic OCR backend for tests, demos, and synthetic universes.
 *
 * It treats the image "bytes" as UTF-8 text and returns them verbatim as the
 * recognized text — so a synthetic source can ship an "image" whose bytes ARE
 * the intended OCR text, and the whole pipeline (download → /inference/ocr →
 * text into the attachment document → indexed → searchable) is exercised
 * end-to-end without a real OCR model or any native dependency.
 *
 * Resolved from `inference.assignments.ocr = "replay"` — the same replay
 * mechanism the agent and the synthetic transcriber use.
 */

import type { OcrCapability, OcrResult } from "@omnesis/core";

export class SyntheticOcr implements OcrCapability {
  readonly name = "synthetic-ocr";
  readonly modelId = "replay";

  // eslint-disable-next-line @typescript-eslint/require-await
  async recognize(
    image: Uint8Array,
    _mimeType: string,
    opts?: { language?: string },
  ): Promise<OcrResult> {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(image).trim();
    // Echo the language hint when given (defaulting to English) so tests can
    // verify the hint flows collector → gateway → capability end-to-end.
    return { text, language: opts?.language ?? "en" };
  }

  async dispose(): Promise<void> {}
}
