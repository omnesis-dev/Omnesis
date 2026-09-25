// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /inference/ocr` — optical character recognition for source attachments.
 *
 * The collector posts raw image (or scanned-PDF) bytes — Content-Type = the
 * attachment MIME type — while extracting an attachment during sync; the
 * gateway runs the configured OCR backend and returns the recognized text. The
 * bytes are held only for the duration of the request — nothing is persisted.
 *Gated behind the `ocr` experimental feature, so the endpoint
 * 404s unless the operator opted in.
 *
 * Scope: `writeAny` — the same scope the collector uses to ingest documents.
 * OCR is part of producing a document's content, not an admin op.
 */

import { createLogger } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { scope } from "../scope.js";
import { BadRequestError } from "../errors.js";
import { MAX_IMAGE_BYTES, type OcrService } from "../../ocr/index.js";
import type { RouteApp } from "./types.js";

const log = createLogger("gateway:http").child("routes:ocr");

const tooLarge = {
  error: `Image body too large (max ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB)`,
  code: "PAYLOAD_TOO_LARGE" as const,
};

// Reject oversized images at the body layer before buffering — mirrors the
// transcribe route. The in-handler byteLength check backstops the rare
// chunked/unknown-Content-Length case the middleware can't reject up front.
const ocrBodyLimit = bodyLimit({
  maxSize: MAX_IMAGE_BYTES,
  onError: (c) => c.json(tooLarge, 413),
});

export interface OcrRoutesDeps {
  ocrService: OcrService;
}

export function mountOcrRoutes(app: RouteApp, deps: OcrRoutesDeps): void {
  const { ocrService } = deps;

  app.post("/inference/ocr", scope.writeAny(), ocrBodyLimit, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) {
      throw new BadRequestError("empty image body");
    }
    if (body.byteLength > MAX_IMAGE_BYTES) {
      return c.json(tooLarge, 413);
    }

    const mimeType = c.req.header("content-type") ?? "application/octet-stream";
    const language = c.req.query("language") || undefined;
    // For a PDF, an optional `?pages=2,5` limits OCR to those 1-based pages
    // (the caller already has native text for the rest). Bad tokens are dropped.
    const pagesParam = c.req.query("pages");
    const pages = pagesParam
      ? pagesParam
          .split(",")
          .map((p) => Number.parseInt(p, 10))
          .filter((n) => Number.isInteger(n) && n > 0)
      : undefined;

    const result = await ocrService.recognize(body, mimeType, {
      language,
      ...(pages && pages.length > 0 ? { pages } : {}),
    });
    if (result === null) {
      // OCR did not run: no backend is configured/loadable, or the input could
      // not be decoded. Successful blank OCR stays available with empty text.
      return c.json({ available: false as const }, 200);
    }
    log.debug(`OCR ${body.byteLength} bytes (${mimeType}) → ${result.text.length} chars`);
    return c.json({ available: true as const, ...result }, 200);
  });
}
