// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /notes/voice` — a Tell Omnesis capture that arrives with its audio
 * for gateway transcription.
 *
 * A phone sends `multipart/form-data` with two parts: `note`, the capture's
 * JSON (the POST /notes fields, with `text` as the device's own transcript —
 * empty when it had none — and the recording's `language`), and `audio`, the
 * recording. The note is saved at once and the answer is 202: the device is
 * done. The gateway's transcriber replaces the note's text later.
 *
 * Responses:
 *   - 202 `{ id, transcription: "pending" }`, also for a retried id.
 *   - 409 `DICTATION_DISABLED` when the operator has not opted in.
 *   - 503 `TRANSCRIBER_UNAVAILABLE` when no transcriber can run.
 *   - 413 `PAYLOAD_TOO_LARGE`, 400 on a malformed body.
 * On any refusal the device saves the note as plain text instead.
 *
 * Scope: that of POST /notes (`write:omnesis-notes`, satisfied by admin).
 */

import { bodyLimit } from "hono/body-limit";
import { notesRateLimiter } from "../../rate-limit.js";
import { MAX_AUDIO_BYTES } from "../../transcribe/index.js";
import { BadRequestError, HttpError, ValidationError } from "../errors.js";
import { enforceWriteScopeForSource, scope } from "../scope.js";
import { voiceNoteMetadata } from "../schemas/index.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { DictationFeatureStatus } from "../../dictation/index.js";
import type { VoiceNoteService } from "../../voice-notes/index.js";
import type { RouteApp } from "./types.js";

/** Room for the `note` part and multipart framing beside the largest recording. */
const METADATA_ALLOWANCE_BYTES = 64 * 1024;

const tooLarge = {
  error: `Audio too large (max ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))} MB)`,
  code: "PAYLOAD_TOO_LARGE",
} as const;

const voiceNoteBodyLimit = bodyLimit({
  maxSize: MAX_AUDIO_BYTES + METADATA_ALLOWANCE_BYTES,
  onError: (c) => c.json(tooLarge, 413),
});

/** The ISO 639 part of a locale or language tag ("en-GB" → "en"), the form Whisper takes. */
export function languageHint(tag: string | undefined): string | undefined {
  const primary = tag?.split(/[-_]/)[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

export interface VoiceNoteRoutesDeps {
  service: VoiceNoteService;
  getStatus: () => DictationFeatureStatus;
}

export function mountVoiceNoteRoutes(app: RouteApp, deps: VoiceNoteRoutesDeps): void {
  const captureLimiter = notesRateLimiter();

  app.post("/notes/voice", scope.writeAny(), voiceNoteBodyLimit, async (c) => {
    if (!isLoopbackRequest(c) && captureLimiter.consume(clientIp(c))) {
      return c.json({ error: "Too many capture requests — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    enforceWriteScopeForSource(c.get("auth").scopes, "omnesis-notes");

    const status = deps.getStatus();
    if (!status.enabled) {
      throw new HttpError(409, "DICTATION_DISABLED", "Gateway transcription is switched off.");
    }
    if (!status.modelAssigned) {
      throw new HttpError(
        503,
        "TRANSCRIBER_UNAVAILABLE",
        status.reason ?? "No transcriber model can run.",
      );
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new BadRequestError("expected a multipart/form-data body");
    }
    const noteJson = form.get("note");
    const audio = form.get("audio");
    if (typeof noteJson !== "string") throw new BadRequestError("missing the note part");
    if (!(audio instanceof File)) throw new BadRequestError("missing the audio part");
    if (audio.size === 0) throw new BadRequestError("empty audio");
    if (audio.size > MAX_AUDIO_BYTES) return c.json(tooLarge, 413);

    let raw: unknown;
    try {
      raw = JSON.parse(noteJson);
    } catch {
      throw new BadRequestError("the note part is not JSON");
    }
    const parsed = voiceNoteMetadata.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Validation failed", parsed.error.issues);
    const note = parsed.data;

    const { id } = await deps.service.accept({
      id: note.id,
      fallbackText: note.text ?? "",
      audio: new Uint8Array(await audio.arrayBuffer()),
      mimeType: audio.type || "application/octet-stream",
      language: languageHint(note.language),
      capturedAt: note.capturedAt,
      capturedTimeZoneId: note.capturedTimeZoneId,
      capturedUtcOffsetSeconds: note.capturedUtcOffsetSeconds,
      surface: note.surface,
      deviceId: note.deviceId,
      latitude: note.latitude,
      longitude: note.longitude,
      placeName: note.placeName,
    });
    return c.json({ id, transcription: "pending" as const }, 202);
  });
}
