// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the OCR capability lifecycle for the gateway — the OCR analog of
 * TranscribeService.
 *
 * - Resolves the `ocr` assignment lazily and caches the loaded capability,
 *   reloading (and disposing the old one) when the assignment changes, so
 *   switching the OCR backend from config takes effect on the next request
 *   without a gateway restart.
 * - Concurrency is backend-aware. A self-hosted HTTP vision server
 *   (vLLM/llama-server) does continuous batching, so recognitions run
 *   concurrently — a burst of attachments, and the pages of one PDF, pipeline
 *   through it instead of trickling one at a time (the dominant slow path
 *   otherwise). Native subprocess backends (Apple Vision, a llama.cpp vision
 *   model, Tesseract) each spawn a process and are torn down on a backend swap,
 *   so they run strictly one at a time, with ensure+recognize serialized so a
 *   swap can't dispose a backend mid-use. The per-backend limit is
 *   `recognitionConcurrency`; `inference.ocr.pageConcurrency` overrides it for
 *   the HTTP/concurrent path.
 * - Rasterizes PDFs to per-page images before handing them to the backend (no
 *   backend takes a PDF directly), then joins the page texts — so scanned /
 *   image-only PDFs become searchable through the same path as images.
 *
 * The HTTP route (`/inference/ocr`) is the only caller; it owns the
 * experimental gate and request-size limit. This service is pure
 * capability+lifecycle infra.
 */

import { createLogger, assertNever } from "@omnesis/core";
import { loadOcrFromResolved, type LoadOcrDeps } from "./loader.js";
import {
  rasterizePdfToImages,
  transcodeHeicToPng,
  isDecodableRasterImage,
  sniffImageKind,
  type PdfRasterizer,
  type ImageTranscoder,
} from "./image-prep.js";
import type { ResolvedAssignment, OcrCapability, OcrResult } from "@omnesis/core";

const log = createLogger("gateway:ocr");

/**
 * Reject images larger than this. Images run bigger than voice notes (a phone
 * photo can be 10+ MB), so the cap is higher than the transcribe cap, but still
 * bounded to guard against abuse.
 */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/**
 * Default number of OCR recognitions run concurrently against an HTTP vision
 * backend (vLLM/llama-server), which does continuous batching — so a burst of
 * attachments, and the pages of one scanned PDF, finish in a few parallel rounds
 * instead of trickling through one at a time. Bounded so a single huge PDF (or a
 * sync firing many attachments at once) can't open hundreds of in-flight
 * requests. This is the HTTP/concurrent default only; native subprocess backends
 * run one at a time (see `recognitionConcurrency`), and
 * `inference.ocr.pageConcurrency` overrides this default.
 */
const DEFAULT_HTTP_CONCURRENCY = 12;

/** Stable signature for a resolved assignment, to detect config changes. */
function signatureOf(resolved: ResolvedAssignment): string {
  switch (resolved.kind) {
    case "local":
      return `local:${resolved.nativeRuntime ?? ""}:${resolved.catalogId}:${resolved.modelPath}:${resolved.available}`;
    case "replay":
      return `replay:${resolved.fixture ?? ""}`;
    case "http":
      return `http:${resolved.backendKey}:${resolved.model}:${resolved.available}`;
    case "anthropic":
      return `anthropic:${resolved.catalogId}:${resolved.available}`;
    case "codex":
      return `codex:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}`;
    case "disabled":
      return "disabled";
    case "unresolved":
      return "unresolved";
    default:
      return assertNever(resolved);
  }
}

function baseMime(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType;
}

function isPdf(mimeType: string): boolean {
  return baseMime(mimeType) === "application/pdf";
}

function isHeic(mimeType: string): boolean {
  const m = baseMime(mimeType);
  return m === "image/heic" || m === "image/heif";
}

export interface OcrServiceDeps extends LoadOcrDeps {
  /** Injectable PDF→images rasterizer (tests). Defaults to the pdftoppm path. */
  rasterizePdf?: PdfRasterizer;
  /** Injectable HEIC→PNG transcoder (tests). Defaults to the heif-convert path. */
  transcodeHeic?: ImageTranscoder;
  /**
   * Operator override for how many OCR recognitions to run concurrently
   * (`inference.ocr.pageConcurrency`) — bounds both a burst of parallel
   * attachments and the pages of one PDF. Applies to the HTTP/concurrent path;
   * native subprocess backends always run one at a time regardless. When unset,
   * the HTTP default is used.
   */
  getPageConcurrency?: () => number | undefined;
}

export class OcrService {
  private readonly resolveAssignment: () => ResolvedAssignment;
  private readonly deps: OcrServiceDeps;
  private readonly rasterizePdf: PdfRasterizer;
  private readonly transcodeHeic: ImageTranscoder;
  private current: { signature: string; capability: OcrCapability | null } | null = null;
  private loading: Promise<OcrCapability | null> | null = null;
  /** Serialization fence for the native (one-at-a-time) backend path. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Backend-call semaphore: in-flight recognitions and parked waiters. */
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(opts: { resolveAssignment: () => ResolvedAssignment; deps?: OcrServiceDeps }) {
    this.resolveAssignment = opts.resolveAssignment;
    this.deps = opts.deps ?? {};
    this.rasterizePdf = this.deps.rasterizePdf ?? rasterizePdfToImages;
    this.transcodeHeic = this.deps.transcodeHeic ?? transcodeHeicToPng;
  }

  private async ensureCapability(): Promise<OcrCapability | null> {
    const resolved = this.resolveAssignment();
    const modalities =
      resolved.kind === "codex"
        ? (this.deps.codexRuntimeService
            ?.snapshot?.()
            .modelDetails?.find((model) => model.id === resolved.model)
            ?.inputModalities?.join(",") ?? "")
        : "";
    const signature = `${signatureOf(resolved)}:${modalities}`;
    if (this.current && this.current.signature === signature) {
      return this.current.capability;
    }
    if (this.loading) return this.loading;

    const previous = this.current?.capability ?? null;
    this.loading = (async () => {
      if (previous) await previous.dispose().catch(() => {});
      const capability = await loadOcrFromResolved(resolved, this.deps);
      this.current = { signature, capability };
      return capability;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Recognize text in image (or PDF) bytes. Returns null when no OCR backend is
   * configured or loadable (caller reports `available: false`). Throws on
   * decode/inference errors so the route surfaces a 5xx rather than silently
   * dropping the image.
   */
  async recognize(
    image: Uint8Array,
    mimeType: string,
    opts?: { language?: string; pages?: number[] },
  ): Promise<OcrResult | null> {
    const resolved = this.resolveAssignment();
    // Native subprocess backends (Apple Vision / Tesseract / gguf) hold a process
    // that a backend swap disposes, and are heavy enough that one at a time is
    // the right load. Run ensure+recognize inside the serialization fence so a
    // swap can't free a backend while an earlier request still runs on it, and so
    // we never spawn two native jobs at once.
    if (resolved.kind === "local") {
      return this.serialize(() => this.runRecognize(resolved, image, mimeType, opts));
    }
    // HTTP / replay backends are stateless per call (dispose is a no-op), so
    // recognitions run concurrently — a self-hosted vision server batches them,
    // turning a sync's burst of attachments into a few parallel rounds. The
    // semaphore (`recognitionConcurrency`) bounds how many hit the backend.
    return this.runRecognize(resolved, image, mimeType, opts);
  }

  private async runRecognize(
    resolved: ResolvedAssignment,
    image: Uint8Array,
    mimeType: string,
    opts?: { language?: string; pages?: number[] },
  ): Promise<OcrResult | null> {
    const capability = await this.ensureCapability();
    if (!capability) return null;
    if (isPdf(mimeType)) {
      return this.recognizePdf(capability, image, opts, resolved);
    }
    // HEIC/HEIF (iPhone photos) aren't decodable by the vLLM/Tesseract image
    // loaders — transcode to PNG first when a transcoder is available. Falls
    // back to the original bytes (a HEIC-capable backend like Apple Vision
    // reads them as-is).
    let bytes = image;
    let mime = mimeType;
    if (isHeic(mimeType)) {
      const png = await this.transcodeHeic(image);
      if (png) {
        bytes = png;
        mime = "image/png";
      }
    }
    // Only hand a real image-loader backend a raster it can decode. Sniff by
    // CONTENT — the MIME label lies after a cross-service import (an SVG/HEIC
    // arriving labelled image/*). An undecodable input (SVG, a HEIC we couldn't
    // transcode, an unknown/corrupt header) makes the vLLM image loader raise
    // `UnidentifiedImageError` and reset the connection, which the collector sees
    // as a transient "fetch failed" and retries forever — stalling the source on
    // one file. Skip it: the document is still indexed (metadata + any non-OCR
    // text), just without OCR, and the sync moves on. The replay backend isn't a
    // real image loader (it echoes bytes for synthetic tests), so it's exempt.
    if (resolved.kind !== "replay" && !isDecodableRasterImage(bytes)) {
      log.warn(
        `OCR skipped — ${mime} bytes are not a decodable raster (sniffed ${sniffImageKind(bytes)}, ${bytes.length}B)`,
      );
      return null;
    }
    return this.withSlot(resolved, () =>
      capability.recognize(bytes, mime, { language: opts?.language }),
    );
  }

  /**
   * Max OCR recognitions to run at once for the resolved backend. Native
   * subprocess backends (Apple Vision / Tesseract / gguf) run strictly one at a
   * time — they're serialized at the request level anyway, and a single PDF's
   * pages must not spawn N processes. An HTTP vision server batches concurrent
   * requests, so it fans out (default 12, `inference.ocr.pageConcurrency`
   * overrides); the in-process replay stub follows the same path. Clamped to ≥1.
   */
  private recognitionConcurrency(resolved: ResolvedAssignment): number {
    if (resolved.kind === "local") return 1;
    const override = this.deps.getPageConcurrency?.();
    return Math.max(1, override ?? DEFAULT_HTTP_CONCURRENCY);
  }

  /**
   * Rasterize a PDF to page images and OCR them. When `opts.pages` is given
   * (1-based), only those pages are OCR'd — the caller (the collector) already
   * has native text for the rest and only needs the image-only pages, so this
   * avoids OCR'ing typed pages. `pageTexts` is returned page-aligned (index =
   * page-1, "" for pages not OCR'd) so the caller can interleave OCR with its
   * native text; `text` is the OCR'd pages joined, for the whole-PDF case.
   */
  private async recognizePdf(
    capability: OcrCapability,
    pdf: Uint8Array,
    opts: { language?: string; pages?: number[] } | undefined,
    resolved: ResolvedAssignment,
  ): Promise<OcrResult | null> {
    const images = await this.rasterizePdf(pdf);
    if (!images || images.length === 0) {
      log.debug("PDF rasterization produced no pages — scanned-PDF OCR unavailable");
      return null;
    }
    const total = images.length;
    // 0-based page indices to OCR: the requested subset (clamped to range), or
    // every page when no subset is specified.
    const targets =
      opts?.pages && opts.pages.length > 0
        ? [...new Set(opts.pages.map((p) => p - 1))]
            .filter((i) => i >= 0 && i < total)
            .sort((a, b) => a - b)
        : images.map((_, i) => i);

    // OCR every target page through the shared semaphore rather than one at a
    // time: an HTTP vision backend (vLLM/llama-server) batches concurrent
    // requests, so a multi-page scanned PDF finishes in a few rounds instead of
    // minutes of sequential calls; native backends fall back to one at a time via
    // the same semaphore. The capability is held for the whole PDF, so concurrent
    // calls to it are safe.
    const pageTexts: string[] = new Array(total).fill("");
    const results = await Promise.all(
      targets.map((i) =>
        this.withSlot(resolved, () =>
          capability.recognize(images[i], "image/png", { language: opts?.language }),
        ).then((r) => ({ i, text: r.text.trim() })),
      ),
    );
    for (const { i, text } of results) pageTexts[i] = text;
    // Join the OCR'd pages in page order.
    const joined = targets
      .map((i) => pageTexts[i])
      .filter(Boolean)
      .join("\n\n")
      .trim();
    // Return page slots even when every recognition is blank. The non-null
    // result tells the collector that OCR ran successfully and the PDF is
    // terminally text-free rather than temporarily unprocessable.
    return { text: joined, pages: total, pageTexts, language: opts?.language };
  }

  /** Run `fn` after all previously-queued recognitions complete (native path). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Run `fn` (one backend recognition) once a concurrency slot is free. The
   * limit is read per-acquire from the resolved backend, so it tracks a config
   * swap — and a shrink (e.g. HTTP→native) simply makes new waiters queue until
   * the in-flight calls on the old backend drain.
   */
  private async withSlot<T>(resolved: ResolvedAssignment, fn: () => Promise<T>): Promise<T> {
    const limit = this.recognitionConcurrency(resolved);
    await this.acquire(limit);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(limit: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = () => {
        if (this.active < limit) {
          this.active++;
          resolve();
        } else {
          this.waiters.push(attempt);
        }
      };
      attempt();
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }

  async dispose(): Promise<void> {
    const capability = this.current?.capability ?? null;
    this.current = null;
    if (capability) {
      await capability.dispose().catch((err) => {
        log.warn(
          `Failed to dispose OCR backend: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}
