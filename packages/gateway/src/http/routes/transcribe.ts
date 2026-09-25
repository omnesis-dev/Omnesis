// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /inference/transcribe` — speech-to-text for source audio.
 *
 * The collector posts raw audio bytes (Content-Type = the audio MIME type)
 * during sync; the gateway runs the configured transcriber model (local
 * Whisper) and returns the transcript. Audio is held only for the duration of
 * the request — nothing is persisted. Gated behind the `stt` experimental
 * feature, so the endpoint 404s unless the operator opted in.
 *
 * Scope: `writeAny` — the same scope the collector uses to ingest documents.
 * Transcription is part of producing a document's content, not an admin op.
 */

import { createLogger } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { scope } from "../scope.js";
import { BadRequestError } from "../errors.js";
import { MAX_AUDIO_BYTES, type TranscribeService } from "../../transcribe/index.js";
import type { RouteApp } from "./types.js";

const log = createLogger("gateway:http").child("routes:transcribe");

// Reject oversized audio at the body layer — `bodyLimit` rejects on a declared
// Content-Length over the cap before reading anything, and aborts a chunked
// upload once it exceeds the cap, so the gateway never buffers an abusive
// payload (the in-handler byteLength check is only a backstop for the rare
// chunked/unknown-length case). Mirrors the agent route's body limit.
const transcribeBodyLimit = bodyLimit({
  maxSize: MAX_AUDIO_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `Audio body too large (max ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))} MB)`,
        code: "PAYLOAD_TOO_LARGE",
      },
      413,
    ),
});

export interface TranscribeRoutesDeps {
  transcribeService: TranscribeService;
}

export function mountTranscribeRoutes(app: RouteApp, deps: TranscribeRoutesDeps): void {
  const { transcribeService } = deps;

  app.post("/inference/transcribe", scope.writeAny(), transcribeBodyLimit, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) {
      throw new BadRequestError("empty audio body");
    }
    // Backstop for the chunked / unknown-Content-Length case the bodyLimit
    // middleware can't reject up front. Match its 413 response shape.
    if (body.byteLength > MAX_AUDIO_BYTES) {
      return c.json(
        {
          error: `Audio body too large (max ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))} MB)`,
          code: "PAYLOAD_TOO_LARGE",
        },
        413,
      );
    }

    const mimeType = c.req.header("content-type") ?? "application/octet-stream";
    const language = c.req.query("language") || undefined;

    const result = await transcribeService.transcribe(body, mimeType, { language });
    if (result === null) {
      // No transcriber configured/loadable. The collector treats this as
      // "no transcript" and renders the plain placeholder.
      return c.json({ available: false as const }, 200);
    }
    log.debug(`Transcribed ${body.byteLength} bytes (${mimeType}) → ${result.text.length} chars`);
    return c.json({ available: true as const, ...result }, 200);
  });
}
