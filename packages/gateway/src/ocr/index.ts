// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OCR subsystem — recognizes text in image and scanned-PDF attachments so it
 * becomes searchable. Mirrors the `transcribe/` subsystem: a lifecycle-owning
 * service resolves the `ocr` capability through the shared InferenceRegistry
 * and dispatches to one of several backends (Apple Vision, a llama.cpp vision
 * GGUF, an OpenAI-compatible vision server, Tesseract, or a synthetic replay
 * backend for tests). Images are held only for the duration of a request —
 * nothing is persisted. Gated behind the `ocr` experimental
 * feature.
 */

// Only the service + its request-size cap are consumed outside this dir (by
// the gateway wiring and the `/inference/ocr` route). The backends, the loader,
// and the deps types are internal — imported directly by their siblings/tests.
export { OcrService, MAX_IMAGE_BYTES } from "./ocr-service.js";
