// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /dictation/transcribe` — gateway dictation for the mobile apps
 * (experimental).
 *
 * A phone posts the audio it recorded at a dictation touchpoint as the raw
 * body (Content-Type = the audio MIME type) and receives the transcript. The
 * audio is held only for the request; nothing is stored. The transcription
 * runs on the shared transcriber's interactive lane, ahead of queued source
 * voice notes.
 *
 * Responses:
 *   - 200 `{ text, language?, durationSec? }`
 *   - 404 when the gateway is not in experimental mode — the path does not
 *     exist, exactly as on a gateway that predates it.
 *   - 409 `DICTATION_DISABLED` when the operator has not opted in.
 *   - 503 `TRANSCRIBER_UNAVAILABLE` when no runnable transcriber is assigned
 *     or the transcription failed. The client falls back to what its on-device
 *     recognizer heard, or asks the person to retry.
 *   - 413 `PAYLOAD_TOO_LARGE` over the advertised `maxAudioBytes`.
 *   - 429 `DICTATION_BUSY` while `MAX_QUEUED_DICTATIONS` are already waiting.
 *
 * A request whose client disconnects while it waits in the queue is dropped
 * before it runs, so a phone that gave up never costs a transcription.
 *
 * Scope: `admin`, the scope the mobile apps' agent and capture calls use.
 * `?language=` optionally carries the phone's ISO 639 language code as a hint.
 */

import { experimentalEnabled } from "@omnesis/core";
import { scope } from "../scope.js";
import { BadRequestError, HttpError, NotFoundError } from "../errors.js";
import {
  MAX_AUDIO_BYTES,
  audioBodyLimit,
  audioTooLargeBody,
  type TranscribeService,
} from "../../transcribe/index.js";
import type { DictationFeatureStatus } from "../../dictation/index.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, RouteApp } from "./types.js";

/**
 * Dictations allowed to wait behind the running transcription. Each holds its
 * whole audio body in memory, and a person is waiting on every one of them, so
 * past this a request is refused at once rather than left to time out.
 */
export const MAX_QUEUED_DICTATIONS = 4;

/** An ISO 639-1/-2 code, the form Whisper accepts. Anything else is ignored. */
const LANGUAGE_CODE = /^[a-z]{2,3}$/;

export interface DictationRoutesDeps {
  transcribeService: TranscribeService;
  getStatus: () => DictationFeatureStatus;
}

export function mountDictationRoutes(app: RouteApp, deps: DictationRoutesDeps): void {
  const { transcribeService, getStatus } = deps;

  // Before auth: with experimental mode off the path does not exist. Read per
  // request, so the answer follows the environment the gateway runs with.
  const gate: MiddlewareHandler<AppEnv> = async (_c, next) => {
    if (!experimentalEnabled()) throw new NotFoundError("Not found");
    await next();
  };

  app.post("/dictation/transcribe", gate, scope.admin(), audioBodyLimit, async (c) => {
    const status = getStatus();
    if (!status.enabled) {
      throw new HttpError(
        409,
        "DICTATION_DISABLED",
        "Gateway dictation is switched off. Turn it on in the transcriber's settings.",
      );
    }
    if (!status.modelAssigned) {
      throw new HttpError(
        503,
        "TRANSCRIBER_UNAVAILABLE",
        status.reason ?? "No transcriber model can run.",
      );
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) throw new BadRequestError("empty audio body");
    // Backstop for a chunked upload the body-limit middleware cannot size up front.
    if (body.byteLength > MAX_AUDIO_BYTES) return c.json(audioTooLargeBody, 413);

    const mimeType = c.req.header("content-type") ?? "application/octet-stream";
    const hint = c.req.query("language")?.toLowerCase();
    const language = hint && LANGUAGE_CODE.test(hint) ? hint : undefined;

    if (transcribeService.interactiveBacklog() >= MAX_QUEUED_DICTATIONS) {
      throw new HttpError(429, "DICTATION_BUSY", "The transcriber is busy. Try again shortly.");
    }
    const result = await transcribeService.transcribe(body, mimeType, {
      language,
      priority: "interactive",
      signal: c.req.raw.signal,
    });
    if (result === null) {
      throw new HttpError(503, "TRANSCRIBER_UNAVAILABLE", "The transcription failed.");
    }
    return c.json({
      text: result.text.trim(),
      ...(result.language !== undefined ? { language: result.language } : {}),
      ...(result.durationSec !== undefined ? { durationSec: result.durationSec } : {}),
    });
  });
}
