// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turn a resolved `transcriber` assignment into a concrete capability —
 * the transcription analog of `loadCompletionFromResolved`.
 *
 * Only local Whisper (and the synthetic replay transcriber for tests) are
 * supported. HTTP and Anthropic assignments resolve to null with a log:
 * transcription is local-only by design (audio is biometric, it never
 * leaves the machine).
 */

import { createLogger, assertNever } from "@omnesis/core";
import { WhisperTranscriber, whisperDepsAvailable } from "./whisper-transcriber.js";
import { SyntheticTranscriber } from "./synthetic-transcriber.js";
import type { ResolvedAssignment, TranscribeCapability } from "@omnesis/core";
import type {
  WhisperModuleLoader,
  WhisperWorkerSpawner,
  AudioDecoder,
} from "./whisper-transcriber.js";

const log = createLogger("gateway:transcribe:loader");

export interface LoadTranscriberDeps {
  /**
   * Injectable native-module loader, used only for the availability probe
   * (tests / a non-default install path). The model itself loads in the worker
   * subprocess.
   */
  loadModule?: WhisperModuleLoader;
  /** Injectable worker spawner (tests run without a real subprocess). */
  spawnWorker?: WhisperWorkerSpawner;
  /** Injectable audio decoder (tests). */
  decodeAudio?: AudioDecoder;
}

export async function loadTranscriberFromResolved(
  resolved: ResolvedAssignment,
  deps: LoadTranscriberDeps = {},
): Promise<TranscribeCapability | null> {
  switch (resolved.kind) {
    case "local": {
      if (!resolved.available) {
        log.warn(
          `Transcriber model ${resolved.catalogId} not available: ${resolved.reason ?? "not installed"}`,
        );
        return null;
      }
      if (!(await whisperDepsAvailable(deps.loadModule))) {
        log.warn(
          "Local transcription needs the smart-whisper and ffmpeg-static optional dependencies — install them to enable Whisper.",
        );
        return null;
      }
      return new WhisperTranscriber({
        modelPath: resolved.modelPath,
        modelId: resolved.catalogId,
        name: resolved.catalogEntry?.name ?? resolved.catalogId,
        spawnWorker: deps.spawnWorker,
        decodeAudio: deps.decodeAudio,
      });
    }
    case "replay":
      return new SyntheticTranscriber();
    case "http":
      log.warn(
        `HTTP transcriber backends are not supported yet (assignment "${resolved.backendKey}/${resolved.model}") — transcription is local-only.`,
      );
      return null;
    case "anthropic":
      log.warn("Anthropic does not offer a transcription model — transcription is local-only.");
      return null;
    case "codex":
      log.warn(
        "Codex does not provide an audio-transcription backend — transcription is local-only.",
      );
      return null;
    case "disabled":
    case "unresolved":
      return null;
    default:
      return assertNever(resolved);
  }
}
