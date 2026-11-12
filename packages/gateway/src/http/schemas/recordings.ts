// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for `routes/recordings.ts` — a conversation a phone
 * records and uploads in numbered chunks (experimental).
 */
import { z } from "zod";

import { MAX_TIME_ZONE_LENGTH, normalizeTimeZone } from "@omnesis/core";

/** The highest chunk number a session may use: about a week of minute-long chunks. */
export const MAX_RECORDING_CHUNK_SEQ = 9_999;
/** The longest one chunk may claim to be. */
const MAX_CHUNK_DURATION_MS = 15 * 60_000;

const isoDateTime = z
  .string()
  .max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time");

/**
 * A zone this gateway does not recognize is dropped rather than refused: it
 * only labels the recording, and refusing it would refuse the recording.
 */
const timeZone = z
  .string()
  .max(MAX_TIME_ZONE_LENGTH)
  .transform((value) => normalizeTimeZone(value) ?? undefined);

/** A recording's id, as path parameter and body field. */
export const recordingId = z.string().uuid();

// POST /recordings
export const startRecordingBody = z
  .object({
    /** Client-generated, so a phone can record before it reaches the gateway. */
    id: recordingId,
    title: z.string().max(200).optional(),
    startedAt: isoDateTime,
    startedTimeZoneId: timeZone.optional(),
    startedUtcOffsetSeconds: z.number().int().min(-64_800).max(64_800).optional(),
    /** Locale or language tag the conversation is in, e.g. "en-GB". */
    language: z.string().max(35).optional(),
    deviceId: z.string().max(128).optional(),
  })
  .strict();
export type StartRecordingBody = z.infer<typeof startRecordingBody>;

/** The `chunk` part of PUT /recordings/:id/chunks/:seq. */
export const recordingChunkMetadata = z
  .object({
    startedAt: isoDateTime,
    durationMs: z.number().int().min(0).max(MAX_CHUNK_DURATION_MS),
    /** Nothing above the device's silence threshold: no audio part is sent. */
    silent: z.boolean().optional(),
    /** The microphone was taken from the recorder during this chunk. */
    interrupted: z.boolean().optional(),
  })
  .strict();

export const recordingChunkSeq = z
  .string()
  .regex(/^\d{1,5}$/, "must be a chunk number")
  .transform(Number)
  .pipe(z.number().int().min(0).max(MAX_RECORDING_CHUNK_SEQ));

// POST /recordings/:id/finish
export const finishRecordingBody = z
  .object({
    chunkCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_RECORDING_CHUNK_SEQ + 1),
    endedAt: isoDateTime,
  })
  .strict();
