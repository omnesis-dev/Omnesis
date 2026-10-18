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
 * warming up), and `MS_PER_AUDIO_SEC` is a generous multiple of whisper.cpp's
 * CPU throughput, so a long recording on a CPU-only host still finishes. It is
 * a hang-catcher, not a performance gate.
 */

import { MAX_TRANSCRIPTION_MS } from "@omnesis/core";

const LOAD_BUDGET_MS = 90_000;
const MS_PER_AUDIO_SEC = 3_000;
const MIN_TIMEOUT_MS = 120_000;

/**
 * The timeout (ms) for a clip of `durationSec` seconds, raised to a caller's
 * `minTimeoutMs`, within the shared ceiling.
 */
export function computeTranscriptionTimeoutMs(durationSec: number, minTimeoutMs = 0): number {
  const budget = LOAD_BUDGET_MS + Math.ceil(Math.max(durationSec, 0) * MS_PER_AUDIO_SEC);
  return Math.min(Math.max(budget, MIN_TIMEOUT_MS, minTimeoutMs), MAX_TRANSCRIPTION_MS);
}
