// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Real-backend OCR integration tests — skipped unless the matching env vars
 * point at a real image / model / endpoint, so CI stays green with no native
 * deps, no model, and no server. Run a single backend locally, e.g.:
 *
 *   OMNESIS_OCR_TEST_TESSERACT_IMAGE=/path/to/printed-text.png \
 *     npx vitest run packages/gateway/src/ocr/ocr-backends.integration.test.ts
 *
 *   OMNESIS_OCR_TEST_VLM_URL=http://localhost:8000 \
 *   OMNESIS_OCR_TEST_VLM_MODEL=dots.ocr \
 *   OMNESIS_OCR_TEST_VLM_IMAGE=/path/to/scan.png \
 *     npx vitest run packages/gateway/src/ocr/ocr-backends.integration.test.ts
 *
 *   OMNESIS_OCR_TEST_GGUF_MODEL=/models/m.gguf \
 *   OMNESIS_OCR_TEST_GGUF_MMPROJ=/models/mmproj.gguf \
 *   OMNESIS_OCR_TEST_GGUF_IMAGE=/path/to/scan.png \
 *   [OMNESIS_OCR_TEST_GGUF_BIN=/path/to/llama-mtmd-cli] \
 *     npx vitest run packages/gateway/src/ocr/ocr-backends.integration.test.ts
 *
 *   # Apple Vision runs only on macOS:
 *   OMNESIS_OCR_TEST_VISION_IMAGE=/path/to/screenshot.png \
 *     npx vitest run packages/gateway/src/ocr/ocr-backends.integration.test.ts
 *
 * Assertions stay loose (non-empty text, a word-like match) since exact OCR
 * output varies by backend, model, and image.
 */

import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { TesseractOcr } from "./tesseract-ocr.js";
import { GgufOcr } from "./gguf-ocr.js";
import { AppleVisionOcr } from "./apple-vision-ocr.js";
import { HttpVlmOcr } from "./http-vlm-ocr.js";

const env = process.env;
const looksLikeText = (s: string) => s.trim().length > 0 && /[a-z]{2,}/i.test(s);

const TESS_IMAGE = env.OMNESIS_OCR_TEST_TESSERACT_IMAGE;
(TESS_IMAGE ? describe : describe.skip)("Tesseract OCR (real)", () => {
  test("recognizes text in a printed image", async () => {
    const ocr = new TesseractOcr();
    const result = await ocr.recognize(new Uint8Array(readFileSync(TESS_IMAGE!)), "image/png");
    expect(looksLikeText(result.text)).toBe(true);
  }, 60_000);
});

const VLM_URL = env.OMNESIS_OCR_TEST_VLM_URL;
const VLM_MODEL = env.OMNESIS_OCR_TEST_VLM_MODEL;
const VLM_IMAGE = env.OMNESIS_OCR_TEST_VLM_IMAGE;
const VLM_RUN = !!VLM_URL && !!VLM_MODEL && !!VLM_IMAGE;
(VLM_RUN ? describe : describe.skip)("HTTP vision-LLM OCR (real)", () => {
  test("recognizes text via a self-hosted vision server", async () => {
    const ocr = new HttpVlmOcr({
      url: VLM_URL!,
      model: VLM_MODEL!,
      apiKey: env.OMNESIS_OCR_TEST_VLM_KEY,
      allowRemoteInference: true,
    });
    const result = await ocr.recognize(new Uint8Array(readFileSync(VLM_IMAGE!)), "image/png");
    expect(looksLikeText(result.text)).toBe(true);
  }, 180_000);
});

const GGUF_MODEL = env.OMNESIS_OCR_TEST_GGUF_MODEL;
const GGUF_MMPROJ = env.OMNESIS_OCR_TEST_GGUF_MMPROJ;
const GGUF_IMAGE = env.OMNESIS_OCR_TEST_GGUF_IMAGE;
const GGUF_RUN = !!GGUF_MODEL && !!GGUF_MMPROJ && !!GGUF_IMAGE;
(GGUF_RUN ? describe : describe.skip)("GGUF (llama-mtmd-cli) OCR (real)", () => {
  test("recognizes text via a local vision GGUF", async () => {
    const ocr = new GgufOcr({
      modelPath: GGUF_MODEL!,
      mmprojPath: GGUF_MMPROJ!,
      binPath: env.OMNESIS_OCR_TEST_GGUF_BIN,
    });
    const result = await ocr.recognize(new Uint8Array(readFileSync(GGUF_IMAGE!)), "image/png");
    expect(looksLikeText(result.text)).toBe(true);
  }, 300_000);
});

const VISION_IMAGE = env.OMNESIS_OCR_TEST_VISION_IMAGE;
const VISION_RUN = !!VISION_IMAGE && process.platform === "darwin";
(VISION_RUN ? describe : describe.skip)("Apple Vision OCR (real, macOS)", () => {
  test("recognizes text in an image via the Vision helper", async () => {
    const ocr = new AppleVisionOcr();
    const result = await ocr.recognize(new Uint8Array(readFileSync(VISION_IMAGE!)), "image/png");
    expect(looksLikeText(result.text)).toBe(true);
  }, 60_000);
});
