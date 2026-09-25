// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CodexCompleter } from "../inference/codex-completer.js";
import { OCR_PROMPT } from "./http-vlm-ocr.js";
import type { ChatBackend } from "@omnesis/agent";
import type { OcrCapability, OcrResult } from "@omnesis/core";

/** Stateless vision turns. The OCR service prepares images and rasterizes PDFs. */
export class CodexOcr implements OcrCapability {
  readonly name: string;
  readonly modelId: string;
  private readonly completer: CodexCompleter;

  constructor(opts: { backend: ChatBackend; timeoutMs?: number }) {
    this.modelId = opts.backend.model;
    this.name = `codex-ocr:${this.modelId}`;
    this.completer = new CodexCompleter({
      backend: opts.backend,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  async recognize(image: Uint8Array, mimeType: string): Promise<OcrResult> {
    // Keep image bytes inline: no temporary corpus files or additional image URL fetches.
    const url = `data:${mimeType || "image/png"};base64,${Buffer.from(image).toString("base64")}`;
    const text = await this.completer.complete(OCR_PROMPT, { images: [{ url }] });
    return { text: text.trim() };
  }

  // Assignment changes must not abort stateless recognitions already in flight.
  // Their deadlines bound them; the runtime service owns the shared backend.
  async dispose(): Promise<void> {}
}
