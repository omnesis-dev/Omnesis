// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Audio transcription seam for sources.
 *
 * A source that carries audio (e.g. WhatsApp voice notes) is handed an
 * `AudioTranscribeFn` the same way it's handed an `AttachmentExtractFn` for
 * binary documents. The collector implements it by forwarding the audio
 * bytes to the gateway's `/inference/transcribe` endpoint, which runs the
 * configured transcriber model (local Whisper) and returns the transcript.
 * The model lives on the gateway (where the GPU and the always-on compute
 * are); the source only ever holds the bytes transiently.
 *
 * Returning `null` means "no transcript" — transcription is disabled, no
 * transcriber is assigned, the audio couldn't be fetched/decoded, or no
 * speech was detected. Callers fall back to a plain placeholder.
 */

import type { TranscriptionResult } from "./models/capabilities.js";

export type { TranscriptionResult } from "./models/capabilities.js";

export type AudioTranscribeFn = (
  data: Uint8Array,
  mimeType: string,
  opts?: {
    /** ISO-639-1 hint to skip language auto-detection. */
    language?: string;
  },
) => Promise<TranscriptionResult | null>;
