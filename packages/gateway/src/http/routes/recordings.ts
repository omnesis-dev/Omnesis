// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recorded conversations (experimental): a phone on the table records a
 * conversation with the screen off and uploads it in numbered chunks while it
 * records. Every route 404s unless the gateway runs with
 * `OMNESIS_EXPERIMENTAL=1`.
 *
 *   - `POST /recordings` opens a session. The id is the device's, so it can
 *     record before it reaches the gateway; a retry answers 200, a new
 *     session 201. 409 `DICTATION_DISABLED` when the operator switched
 *     gateway transcription off. A transcriber that cannot run *yet* is not
 *     a refusal: the chunks wait for it.
 *   - `PUT /recordings/:id/chunks/:seq` stores one chunk: multipart with a
 *     `chunk` JSON part and an `audio` part (absent for a silent chunk).
 *     Idempotent per seq. 404 for an unknown session, 409 for a seq past a
 *     finished session's declared count.
 *   - `POST /recordings/:id/finish` declares the chunk count; idempotent, 409
 *     when a different count was declared first.
 *   - `GET /recordings/:id` reports progress.
 *   - `DELETE /recordings/:id` removes the session, its chunks and its document.
 *   - `GET /recordings?limit=` lists the most recent sessions, with how many
 *     speakers each has and how many the owner has named.
 *   - `GET /recordings/:id/speakers` lists a session's speakers with how long
 *     each spoke and the first things they said.
 *   - `PUT /recordings/:id/speakers/:n` says who speaker `n` is — `{self:
 *     true}`, `{personId}`, `{name}` or `{clear: true}` — and the document is
 *     written again. 404 for a speaker the session does not have, 400 for a
 *     person id that names nobody.
 *
 * Scope: `write:omnesis-recordings` (satisfied by admin).
 */

import { experimentalEnabled } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { recordingsRateLimiter } from "../../rate-limit.js";
import { OMNESIS_RECORDINGS_SOURCE_ID } from "../../sources/omnesis-recordings/index.js";
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { enforceWriteScopeForSource, scope } from "../scope.js";
import {
  finishRecordingBody,
  listRecordingsQuery,
  recordingChunkMetadata,
  recordingSpeakerNumber,
  setRecordingSpeakerBody,
  recordingChunkSeq,
  recordingId,
  startRecordingBody,
} from "../schemas/index.js";
import { transcriptionVocabularyAllowed } from "../transcription-access.js";
import { validateJson, validateQuery } from "../validate.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import { languageHint } from "./voice-notes.js";
import type { DictationFeatureStatus } from "../../dictation/index.js";
import type { RecordingTranscriptionService } from "../../recordings/index.js";
import type { RecordingSpeakerMapping } from "../../recordings/storage.js";
import type { Context, Next } from "hono";
import type { RouteApp } from "./types.js";

/** The largest chunk accepted: several minutes of compressed speech, or a minute of WAV. */
export const MAX_RECORDING_CHUNK_BYTES = 10 * 1024 * 1024;
const METADATA_ALLOWANCE_BYTES = 16 * 1024;

const tooLarge = {
  error: `Chunk too large (max ${MAX_RECORDING_CHUNK_BYTES / (1024 * 1024)} MB)`,
  code: "PAYLOAD_TOO_LARGE",
} as const;

export interface RecordingRoutesDeps {
  service: RecordingTranscriptionService;
  /** The dictation verdict: whether the operator lets the gateway transcribe. */
  getStatus: () => Promise<DictationFeatureStatus>;
  /** Whether the routes exist; experimental mode by default. */
  enabled?: () => boolean;
}

function parseId(raw: string): string {
  const parsed = recordingId.safeParse(raw);
  if (!parsed.success) throw new NotFoundError("recording not found");
  return parsed.data;
}

export function mountRecordingRoutes(app: RouteApp, deps: RecordingRoutesDeps): void {
  const enabled = deps.enabled ?? experimentalEnabled;
  const limiter = recordingsRateLimiter();

  const gate = async (c: Context, next: Next) => {
    if (!enabled()) return c.notFound();
    if (!isLoopbackRequest(c) && limiter.consume(clientIp(c))) {
      return c.json({ error: "Too many recording requests — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    await next();
    return undefined;
  };
  app.use("/recordings", gate);
  app.use("/recordings/*", gate);

  const enforceScope = (c: Context): void =>
    enforceWriteScopeForSource(c.get("auth").scopes, OMNESIS_RECORDINGS_SOURCE_ID);

  app.post("/recordings", scope.writeAny(), validateJson(startRecordingBody), async (c) => {
    enforceScope(c);
    const status = await deps.getStatus();
    if (!status.enabled) {
      throw new HttpError(409, "DICTATION_DISABLED", "Gateway transcription is switched off.");
    }
    const body = c.req.valid("json");
    const { created } = await deps.service.startSession({
      id: body.id,
      title: body.title,
      startedAt: new Date(body.startedAt).toISOString(),
      startedTimeZoneId: body.startedTimeZoneId,
      startedUtcOffsetSeconds: body.startedUtcOffsetSeconds,
      language: languageHint(body.language),
      // The paired device the token belongs to, over what the body claims.
      deviceId: c.get("auth").deviceId ?? body.deviceId,
      allowVocabulary: transcriptionVocabularyAllowed(c.get("auth").scopes),
    });
    return c.json(deps.service.status(body.id), created ? 201 : 200);
  });

  app.put(
    "/recordings/:id/chunks/:seq",
    scope.writeAny(),
    bodyLimit({
      maxSize: MAX_RECORDING_CHUNK_BYTES + METADATA_ALLOWANCE_BYTES,
      onError: (c) => c.json(tooLarge, 413),
    }),
    async (c) => {
      enforceScope(c);
      const id = parseId(c.req.param("id"));
      const seqParsed = recordingChunkSeq.safeParse(c.req.param("seq"));
      if (!seqParsed.success)
        throw new ValidationError("Validation failed", seqParsed.error.issues);
      const seq = seqParsed.data;

      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new BadRequestError("expected a multipart/form-data body");
      }
      const chunkJson = form.get("chunk");
      if (typeof chunkJson !== "string") throw new BadRequestError("missing the chunk part");
      let raw: unknown;
      try {
        raw = JSON.parse(chunkJson);
      } catch {
        throw new BadRequestError("the chunk part is not JSON");
      }
      const parsed = recordingChunkMetadata.safeParse(raw);
      if (!parsed.success) throw new ValidationError("Validation failed", parsed.error.issues);
      const meta = parsed.data;

      const audio = form.get("audio");
      let bytes: Uint8Array | null = null;
      let mimeType: string | null = null;
      if (audio !== null) {
        if (!(audio instanceof File)) throw new BadRequestError("the audio part is not a file");
        if (audio.size > MAX_RECORDING_CHUNK_BYTES) return c.json(tooLarge, 413);
        if (audio.size > 0) {
          bytes = new Uint8Array(await audio.arrayBuffer());
          mimeType = audio.type || "application/octet-stream";
        }
      }
      const silent = meta.silent === true;
      if (!silent && bytes === null) throw new BadRequestError("missing the audio part");

      const outcome = await deps.service.addChunk({
        sessionId: id,
        seq,
        startedAt: new Date(meta.startedAt).toISOString(),
        durationMs: meta.durationMs,
        silent,
        interrupted: meta.interrupted === true,
        audio: silent ? null : bytes,
        mimeType: silent ? null : mimeType,
      });
      if (outcome === "missing") throw new NotFoundError("recording not found");
      if (outcome === "beyond") {
        throw new ConflictError(`chunk ${seq} is past the recording's declared chunk count`);
      }
      return c.json({ seq, status: outcome });
    },
  );

  app.post(
    "/recordings/:id/finish",
    scope.writeAny(),
    validateJson(finishRecordingBody),
    async (c) => {
      enforceScope(c);
      const id = parseId(c.req.param("id"));
      const body = c.req.valid("json");
      const outcome = await deps.service.finish(
        id,
        body.chunkCount,
        new Date(body.endedAt).toISOString(),
      );
      if (outcome === "missing") throw new NotFoundError("recording not found");
      if (outcome === "conflict") {
        throw new ConflictError("the recording was finished with a different chunk count");
      }
      return c.json(deps.service.status(id));
    },
  );

  app.get("/recordings/:id", scope.writeAny(), (c) => {
    enforceScope(c);
    const status = deps.service.status(parseId(c.req.param("id")));
    if (!status) throw new NotFoundError("recording not found");
    c.header("Cache-Control", "no-store");
    return c.json(status);
  });

  app.get("/recordings", scope.writeAny(), validateQuery(listRecordingsQuery), (c) => {
    enforceScope(c);
    c.header("Cache-Control", "no-store");
    return c.json({ recordings: deps.service.recent(c.req.valid("query").limit ?? 20) });
  });

  app.get("/recordings/:id/speakers", scope.writeAny(), (c) => {
    enforceScope(c);
    const speakers = deps.service.speakers(parseId(c.req.param("id")));
    if (!speakers) throw new NotFoundError("recording not found");
    c.header("Cache-Control", "no-store");
    return c.json({ speakers });
  });

  app.put(
    "/recordings/:id/speakers/:speaker",
    scope.writeAny(),
    validateJson(setRecordingSpeakerBody),
    async (c) => {
      enforceScope(c);
      const id = parseId(c.req.param("id"));
      const speaker = recordingSpeakerNumber.safeParse(c.req.param("speaker"));
      if (!speaker.success) throw new NotFoundError("speaker not found");
      const body = c.req.valid("json");
      const mapping: RecordingSpeakerMapping =
        "self" in body
          ? { kind: "self" }
          : "personId" in body
            ? { kind: "person", personId: body.personId }
            : "name" in body
              ? { kind: "name", name: body.name }
              : { kind: "clear" };
      const outcome = await deps.service.setSpeaker(id, speaker.data, mapping);
      if (outcome === "missing") throw new NotFoundError("speaker not found");
      if (outcome === "no-such-person") throw new BadRequestError("no such person");
      return c.json({ speakers: deps.service.speakers(id) ?? [] });
    },
  );

  app.delete("/recordings/:id", scope.writeAny(), async (c) => {
    enforceScope(c);
    const deleted = await deps.service.delete(parseId(c.req.param("id")));
    if (!deleted) throw new NotFoundError("recording not found");
    return c.body(null, 204);
  });
}
