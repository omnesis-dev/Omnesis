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
 *   - `GET /recordings/:id/chunks` answers a session as the list shows it,
 *     with its chunks: their state, and whether their audio is still kept and
 *     until when.
 *   - `GET /recordings/:id/chunks/:seq/audio` answers a settled chunk's kept
 *     audio; 404 when none is kept (the default: audio is deleted once the
 *     chunk is transcribed) or the chunk is still waiting for the transcriber.
 *   - `PUT /recordings/:id/title` gives the recording the owner's title
 *     (`{title}`; null goes back to the date-based one), and the document is
 *     written again.
 *   - `GET /recordings/:id/suggestions` offers who likely took part and what
 *     the recording was: attendees and the title of calendar events it
 *     overlaps. Nothing is applied: the owner accepts one through the
 *     speaker and title routes, or dismisses it with
 *     `POST /recordings/:id/suggestions/dismiss` (`{key}`).
 *   - `GET /recordings/:id/speakers` lists a session's speakers with how long
 *     each spoke and the first things they said, and the people present
 *     without a speaking turn (`participants`).
 *   - `PUT /recordings/:id/speakers/:n` says who speaker `n` is — `{self:
 *     true}`, `{personId}`, `{name}` or `{clear: true}` — and the document is
 *     written again. 404 for a speaker the session does not have, 400 for a
 *     person id that names nobody.
 *   - `POST /recordings/:id/participants` adds someone who was present but
 *     not told apart as a speaker — `{personId}` or `{name}` — and the
 *     document is written again; adding them twice changes nothing.
 *     `DELETE /recordings/:id/participants/:key` removes one. Both answer the
 *     participants; 404 for an unknown session or participant, 400 for a
 *     person id that names nobody.
 *   - A speaker the gateway recognised by the owner's voice reads
 *     `selfMatched: true`; mapping it otherwise undoes the recognition for
 *     that session.
 *   - `GET /recordings/self-voice` says whether the owner's voice is enrolled
 *     and can be used (`inference.recordings.selfVoice`).
 *   - `PUT /recordings/self-voice` enrols it from a multipart `audio` part of
 *     the owner reading aloud, replacing any before; only one mean voice
 *     vector is kept. 409 `SELF_VOICE_OFF` while the setting is off, 503
 *     `VOICES_UNAVAILABLE` while voices cannot be separated, 422
 *     `SELF_VOICE_UNREADABLE`, `SELF_VOICE_TOO_SHORT` or
 *     `SELF_VOICE_SEVERAL_VOICES` for a clip that cannot be enrolled, and 409
 *     `SELF_VOICE_SUPERSEDED` when the voice was deleted, switched off or
 *     enrolled again by a later request while the clip was being read.
 *   - `DELETE /recordings/self-voice` deletes it, and refuses enrolments still
 *     under way.
 *
 * Scope: `write:omnesis-recordings` (satisfied by admin).
 */

import { assertNever, experimentalEnabled } from "@omnesis/core";
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
  addRecordingParticipantBody,
  dismissRecordingSuggestionBody,
  finishRecordingBody,
  setRecordingTitleBody,
  listRecordingsQuery,
  recordingChunkMetadata,
  recordingParticipantKey,
  recordingSpeakerNumber,
  setRecordingSpeakerBody,
  recordingChunkSeq,
  recordingId,
  startRecordingBody,
} from "../schemas/index.js";
import { transcriptionVocabularyAllowed } from "../transcription-access.js";
import { validateJson, validateQuery } from "../validate.js";
import { MIN_ENROLMENT_SPEECH_MS } from "../../recordings/service.js";
import { credentialRateLimitKey, isLoopbackRequest } from "./admin/internals.js";
import { languageHint } from "./voice-notes.js";
import type { DictationFeatureStatus } from "../../dictation/index.js";
import type { RecordingTranscriptionService } from "../../recordings/index.js";
import type { RecordingSpeakerMapping } from "../../recordings/storage.js";
import type { Context, Next } from "hono";
import type { RouteApp } from "./types.js";

/** The largest chunk accepted: several minutes of compressed speech, or a minute of WAV. */
export const MAX_RECORDING_CHUNK_BYTES = 10 * 1024 * 1024;
const METADATA_ALLOWANCE_BYTES = 16 * 1024;
/** A media type served back as it was uploaded: audio, and nothing that could carry parameters. */
const AUDIO_TYPE = /^audio\/[a-z0-9.+-]{1,64}$/i;

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
    if (!isLoopbackRequest(c) && limiter.consume(credentialRateLimitKey(c))) {
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
      origin: body.origin,
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

  // Before `/recordings/:id`, which would take `self-voice` for an id.
  app.get("/recordings/self-voice", scope.writeAny(), (c) => {
    enforceScope(c);
    c.header("Cache-Control", "no-store");
    return c.json(deps.service.selfVoiceStatus());
  });

  app.put(
    "/recordings/self-voice",
    scope.writeAny(),
    bodyLimit({
      maxSize: MAX_RECORDING_CHUNK_BYTES + METADATA_ALLOWANCE_BYTES,
      onError: (c) => c.json(tooLarge, 413),
    }),
    async (c) => {
      enforceScope(c);
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new BadRequestError("expected a multipart/form-data body");
      }
      const audio = form.get("audio");
      if (!(audio instanceof File) || audio.size === 0) {
        throw new BadRequestError("missing the audio part");
      }
      if (audio.size > MAX_RECORDING_CHUNK_BYTES) return c.json(tooLarge, 413);
      const outcome = await deps.service.enrollSelfVoice(
        new Uint8Array(await audio.arrayBuffer()),
        audio.type || "application/octet-stream",
      );
      switch (outcome.kind) {
        case "enrolled":
          return c.json(outcome.status);
        case "off":
          throw new HttpError(
            409,
            "SELF_VOICE_OFF",
            "Recognising your voice is off: set inference.recordings.selfVoice to match.",
          );
        case "unavailable":
          throw new HttpError(
            503,
            "VOICES_UNAVAILABLE",
            "Voices cannot be told apart yet: speakers are off, or the voice models are still downloading.",
          );
        case "unreadable":
          throw new HttpError(422, "SELF_VOICE_UNREADABLE", "The recording could not be read.");
        case "too-short":
          throw new HttpError(
            422,
            "SELF_VOICE_TOO_SHORT",
            `The recording holds ${Math.round(outcome.speechMs / 1000)} seconds of speech; read aloud for at least ${Math.round(MIN_ENROLMENT_SPEECH_MS / 1000)}.`,
            { speechMs: outcome.speechMs, minSpeechMs: MIN_ENROLMENT_SPEECH_MS },
          );
        case "several-voices":
          throw new HttpError(
            422,
            "SELF_VOICE_SEVERAL_VOICES",
            "More than one voice is heard in the recording; record yourself alone.",
          );
        case "superseded":
          throw new HttpError(
            409,
            "SELF_VOICE_SUPERSEDED",
            "Your voice was deleted, switched off or enrolled again while this recording was being read; nothing was stored.",
          );
        default:
          return assertNever(outcome);
      }
    },
  );

  app.delete("/recordings/self-voice", scope.writeAny(), async (c) => {
    enforceScope(c);
    await deps.service.deleteSelfVoice();
    return c.body(null, 204);
  });

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

  app.get("/recordings/:id/chunks", scope.writeAny(), (c) => {
    enforceScope(c);
    const id = parseId(c.req.param("id"));
    const recording = deps.service.summary(id);
    const chunks = deps.service.chunks(id);
    if (!recording || !chunks) throw new NotFoundError("recording not found");
    c.header("Cache-Control", "no-store");
    return c.json({ recording, chunks });
  });

  app.get("/recordings/:id/chunks/:seq/audio", scope.writeAny(), (c) => {
    enforceScope(c);
    const id = parseId(c.req.param("id"));
    const seq = recordingChunkSeq.safeParse(c.req.param("seq"));
    if (!seq.success) throw new NotFoundError("audio not found");
    const kept = deps.service.chunkAudio(id, seq.data);
    if (!kept) throw new NotFoundError("audio not found");
    // The type is the uploading device's word: only an audio type is echoed,
    // and the body is never rendered as a page on the gateway's origin.
    return c.body(kept.audio, 200, {
      "Content-Type": AUDIO_TYPE.test(kept.mimeType) ? kept.mimeType : "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="recording-${id}-${seq.data}"`,
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.put(
    "/recordings/:id/title",
    scope.writeAny(),
    validateJson(setRecordingTitleBody),
    async (c) => {
      enforceScope(c);
      const id = parseId(c.req.param("id"));
      if (!(await deps.service.setTitle(id, c.req.valid("json").title))) {
        throw new NotFoundError("recording not found");
      }
      return c.json(deps.service.summary(id));
    },
  );

  app.get("/recordings/:id/suggestions", scope.writeAny(), async (c) => {
    enforceScope(c);
    const suggestions = await deps.service.suggestions(parseId(c.req.param("id")));
    if (!suggestions) throw new NotFoundError("recording not found");
    c.header("Cache-Control", "no-store");
    return c.json(suggestions);
  });

  app.post(
    "/recordings/:id/suggestions/dismiss",
    scope.writeAny(),
    validateJson(dismissRecordingSuggestionBody),
    async (c) => {
      enforceScope(c);
      const id = parseId(c.req.param("id"));
      if (!(await deps.service.dismissSuggestion(id, c.req.valid("json").key))) {
        throw new NotFoundError("recording not found");
      }
      return c.body(null, 204);
    },
  );

  app.get("/recordings/:id/speakers", scope.writeAny(), (c) => {
    enforceScope(c);
    const id = parseId(c.req.param("id"));
    const speakers = deps.service.speakers(id);
    if (!speakers) throw new NotFoundError("recording not found");
    c.header("Cache-Control", "no-store");
    return c.json({ speakers, participants: deps.service.participants(id) ?? [] });
  });

  app.post(
    "/recordings/:id/participants",
    scope.writeAny(),
    validateJson(addRecordingParticipantBody),
    async (c) => {
      enforceScope(c);
      const id = parseId(c.req.param("id"));
      const outcome = await deps.service.addParticipant(id, c.req.valid("json"));
      if (outcome === "missing") throw new NotFoundError("recording not found");
      if (outcome === "no-such-person") throw new BadRequestError("no such person");
      return c.json({ participants: deps.service.participants(id) ?? [] });
    },
  );

  app.delete("/recordings/:id/participants/:key", scope.writeAny(), async (c) => {
    enforceScope(c);
    const id = parseId(c.req.param("id"));
    const key = recordingParticipantKey.safeParse(c.req.param("key"));
    if (!key.success) throw new NotFoundError("participant not found");
    if (!(await deps.service.removeParticipant(id, key.data))) {
      throw new NotFoundError("participant not found");
    }
    return c.json({ participants: deps.service.participants(id) ?? [] });
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
