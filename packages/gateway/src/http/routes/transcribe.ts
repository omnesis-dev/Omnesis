// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /inference/transcribe` — speech-to-text for source audio.
 *
 * The collector posts raw audio bytes (Content-Type = the audio MIME type)
 * during sync; the gateway runs the configured transcriber (a local Whisper
 * model or an HTTP transcription backend) and returns the transcript. Audio is
 * held only for the duration of the request — nothing is persisted. Without a
 * runnable transcriber the route answers `{ available: false }`.
 *
 * Scope: `writeAny` — the same scope the collector uses to ingest documents.
 * Transcription is part of producing a document's content, not an admin op.
 */

import { assertNever, createLogger } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { scope } from "../scope.js";
import { BadRequestError, ServiceUnavailableError } from "../errors.js";
import { MAX_AUDIO_BYTES, type TranscribeService } from "../../transcribe/index.js";
import { transcriptionContextSchema } from "../schemas/transcription.js";
import { transcriptionVocabularyAllowed } from "../transcription-access.js";
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
    const rawContext = c.req.header("x-omnesis-transcription-context");
    let context;
    if (rawContext !== undefined) {
      if (rawContext.length > 8192) throw new BadRequestError("Transcription context is too large");
      try {
        context = transcriptionContextSchema.parse(JSON.parse(decodeURIComponent(rawContext)));
      } catch {
        throw new BadRequestError("Invalid transcription context");
      }
    }

    const outcome = await transcribeService.transcribeOutcome(body, mimeType, {
      language,
      context,
      allowVocabulary: transcriptionVocabularyAllowed(c.get("auth").scopes),
      // A collector that stopped waiting retries the note on a later sync, so
      // work it no longer waits for is skipped or stopped.
      signal: c.req.raw.signal,
    });
    switch (outcome.kind) {
      case "unavailable":
        return c.json({ available: false as const }, 200);
      case "failed":
      case "cancelled":
        // Keep decoder/backend diagnostics in server logs, not source documents.
        throw new ServiceUnavailableError("Transcription failed; the audio will be retried.");
      case "transcribed":
        log.debug(
          `Transcribed ${body.byteLength} bytes (${mimeType}) → ${outcome.result.text.length} chars`,
        );
        return c.json({ available: true as const, ...outcome.result }, 200);
      default:
        return assertNever(outcome);
    }
  });
}
