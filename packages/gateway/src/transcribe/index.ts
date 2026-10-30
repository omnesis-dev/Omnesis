// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Speech-to-text — gateway-hosted transcription.
 *
 *   - `TranscribeService`    — capability lifecycle + serialized inference.
 *   - `WhisperTranscriber`   — local whisper.cpp backend (smart-whisper).
 *   - `HttpTranscriber`      — OpenAI-compatible transcription server backend.
 *   - `ChatAudioTranscriber` — a speech model behind a chat API, audio in the message.
 *   - `SyntheticTranscriber` — deterministic replay backend for tests.
 *   - `loadTranscriberFromResolved` — resolved assignment → capability.
 *   - `decodeToPcm16kMono`   — ffmpeg-static audio → PCM decode.
 *
 * Consumed by the `/inference/transcribe` route; the collector reaches it
 * over HTTP via `GatewayClient.transcribe`.
 */

export {
  TranscribeService,
  MAX_AUDIO_BYTES,
  assignmentReadiness,
  verifyTranscriberAssignment,
} from "./transcribe-service.js";
export type { TranscriberReadiness } from "./transcribe-service.js";
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
  WhisperTranscriberOptions,
} from "./whisper-transcriber.js";
export { HttpTranscriber } from "./http-transcriber.js";
export { ChatAudioTranscriber } from "./chat-audio-transcriber.js";
export type { ChatAudioTranscriberOptions } from "./chat-audio-transcriber.js";
export type { HttpTranscriberOptions } from "./http-transcriber.js";
export { SyntheticTranscriber } from "./synthetic-transcriber.js";
export { loadTranscriberFromResolved } from "./loader.js";
export type { LoadTranscriberDeps } from "./loader.js";
export { decodeToPcm16kMono, resolveFfmpegPath, AudioDecodeError } from "./audio-decode.js";
export type { AudioDecoder } from "./audio-decode.js";
