// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Speech-to-text — gateway-hosted transcription.
 *
 *   - `TranscribeService`    — capability lifecycle + serialized inference.
 *   - `WhisperTranscriber`   — local whisper.cpp backend (smart-whisper).
 *   - `SyntheticTranscriber` — deterministic replay backend for tests.
 *   - `loadTranscriberFromResolved` — resolved assignment → capability.
 *   - `decodeToPcm16kMono`   — ffmpeg-static audio → PCM decode.
 *
 * Consumed by the `/inference/transcribe` route; the collector reaches it
 * over HTTP via `GatewayClient.transcribe`.
 */

export { TranscribeService, MAX_AUDIO_BYTES } from "./transcribe-service.js";
export {
  WhisperTranscriber,
  whisperDepsAvailable,
  defaultWhisperLoader,
  defaultWhisperSpawner,
} from "./whisper-transcriber.js";
export type {
  WhisperModuleLoader,
  WhisperWorkerSpawner,
  WhisperWorkerProcess,
  AudioDecoder,
  WhisperTranscriberOptions,
} from "./whisper-transcriber.js";
export { SyntheticTranscriber } from "./synthetic-transcriber.js";
export { loadTranscriberFromResolved } from "./loader.js";
export type { LoadTranscriberDeps } from "./loader.js";
export { decodeToPcm16kMono, resolveFfmpegPath, AudioDecodeError } from "./audio-decode.js";
