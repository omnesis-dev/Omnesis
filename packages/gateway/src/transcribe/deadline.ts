// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-request wall-clock budget, shared by every transcriber backend. A
 * request carries one chunk of a recording (see `chunks.ts`).
 *
 * The budget is derived from the chunk's duration rather than a flat number:
 * `LOAD_BUDGET + MS_PER_AUDIO_SEC × durationSec`, floored for tiny clips and
 * ceiled at `MAX_CHUNK_TIMEOUT_MS` so a call that never returns is still given
 * up rather than wedging the serialized queue. The load budget covers a cold
 * model load (a local Whisper reload after idle offload, or a backend server
 * warming up), and `MS_PER_AUDIO_SEC` is a generous multiple of the slowest
 * engine still worth waiting for: an audio language model such as Qwen3-ASR on
 * a CPU takes about twelve seconds per second of speech, several times
 * whisper.cpp's CPU rate, and a recording it is still working on is not a hang. It is
 * a hang-catcher, not a performance gate.
 *
 * The ceiling binds only above 114 seconds of audio. An audio language model
 * gets one-minute chunks (990 s each, past its ~720 s at twelve seconds per
 * second), so the rate is what sizes its deadline; the ten-minute chunks of
 * Whisper and the transcription API get the ceiling, three seconds per second
 * of audio, several times whisper.cpp's CPU rate.
 */

const LOAD_BUDGET_MS = 90_000;
const MS_PER_AUDIO_SEC = 15_000;
const MIN_TIMEOUT_MS = 180_000;
/** The longest one request may take, whatever its duration or a caller's minimum. */
export const MAX_CHUNK_TIMEOUT_MS = 30 * 60_000;

/**
 * The timeout (ms) for a chunk of `durationSec` seconds, raised to a caller's
 * `minTimeoutMs`, within the per-request ceiling.
 */
export function computeTranscriptionTimeoutMs(durationSec: number, minTimeoutMs = 0): number {
  const budget = LOAD_BUDGET_MS + Math.ceil(Math.max(durationSec, 0) * MS_PER_AUDIO_SEC);
  return Math.min(Math.max(budget, MIN_TIMEOUT_MS, minTimeoutMs), MAX_CHUNK_TIMEOUT_MS);
}
