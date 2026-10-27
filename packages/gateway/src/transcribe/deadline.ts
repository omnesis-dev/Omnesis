// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-transcription wall-clock budget, shared by every transcriber backend.
 *
 * The budget is derived from the clip's duration rather than a flat number:
 * `LOAD_BUDGET + MS_PER_AUDIO_SEC × durationSec`, floored for tiny clips and
 * ceiled at `MAX_TRANSCRIPTION_MS` so a call that never returns is still given
 * up rather than wedging the serialized queue. The load budget covers a cold
 * model load (a local Whisper reload after idle offload, or a backend server
 * warming up), and `MS_PER_AUDIO_SEC` is a generous multiple of the slowest
 * engine still worth waiting for: an audio language model such as Qwen3-ASR on
 * a CPU takes about twelve seconds per second of speech, several times
 * whisper.cpp's CPU rate, and a recording it is still working on is not a hang. It is
 * a hang-catcher, not a performance gate.
 */

import { MAX_TRANSCRIPTION_MS } from "@omnesis/core";

const LOAD_BUDGET_MS = 90_000;
const MS_PER_AUDIO_SEC = 15_000;
const MIN_TIMEOUT_MS = 180_000;

/**
 * The timeout (ms) for a clip of `durationSec` seconds, raised to a caller's
 * `minTimeoutMs`, within the shared ceiling.
 */
export function computeTranscriptionTimeoutMs(durationSec: number, minTimeoutMs = 0): number {
  const budget = LOAD_BUDGET_MS + Math.ceil(Math.max(durationSec, 0) * MS_PER_AUDIO_SEC);
  return Math.min(Math.max(budget, MIN_TIMEOUT_MS, minTimeoutMs), MAX_TRANSCRIPTION_MS);
}
