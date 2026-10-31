// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turn a resolved `transcriber` assignment into a concrete capability —
 * the transcription analog of `loadCompletionFromResolved`.
 *
 * Backends:
 *   - `local`  → in-process whisper.cpp (`smart-whisper`).
 *   - `http`   → a backend declared in `inference.backends`, through its
 *                OpenAI-compatible transcription endpoint (a GPU whisper
 *                server, speaches, vLLM, llama-server, Ollama, a hosted API)
 *                or, for a speech model served only through a chat API, a
 *                chat completion carrying the audio. The inference URL policy
 *                keeps it on loopback unless the operator allows remote
 *                inference.
 *   - `replay` → the synthetic transcriber for tests.
 *
 * The chat-agent backends (Anthropic, Codex, Claude Code) offer no
 * transcription model and resolve to null with a log.
 */

import { createLogger, assertNever } from "@omnesis/core";
import { WhisperTranscriber, whisperDepsAvailable } from "./whisper-transcriber.js";
import { SyntheticTranscriber } from "./synthetic-transcriber.js";
import { HttpTranscriber } from "./http-transcriber.js";
import { ChatAudioTranscriber } from "./chat-audio-transcriber.js";
import type { ResolvedAssignment, TranscribeCapability } from "@omnesis/core";
import type { WhisperModuleLoader, WhisperWorkerSpawner } from "./whisper-transcriber.js";
import type { AudioDecoder } from "./audio-decode.js";

import type { InferenceHealth } from "../inference/model-health.js";

const log = createLogger("gateway:transcribe:loader");

export interface LoadTranscriberDeps {
  health?: InferenceHealth;
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
  /** Resolve the bearer token for an HTTP backend (the registry owns the keys). */
  getBackendApiKey?: (backendKey: string) => string | undefined;
  /** Injectable `fetch` for the HTTP backend (tests). */
  fetchFn?: typeof fetch;
}

export async function loadTranscriberFromResolved(
  resolved: ResolvedAssignment,
  deps: LoadTranscriberDeps = {},
): Promise<TranscribeCapability | null> {
  const beginModelCall = deps.health?.callFactory(resolved.role);
  const provider = await loadProvider(resolved, deps);
  return provider && deps.health
    ? deps.health.observe(resolved, provider, ["transcribe"], beginModelCall)
    : provider;
}

async function loadProvider(
  resolved: ResolvedAssignment,
  deps: LoadTranscriberDeps,
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
      if (!resolved.model) {
        log.warn(
          `Transcriber HTTP backend "${resolved.backendKey}" has no model — set one in the assignment.`,
        );
        return null;
      }
      if (!resolved.available) {
        // The registry has a reason: the backend is down, or its transcription
        // probe found it cannot transcribe (a chat-only server such as Ollama).
        // Building a transcriber for it would only turn every voice note into
        // a failed request.
        log.warn(
          `Transcriber HTTP backend "${resolved.backendKey}" cannot run: ${resolved.reason ?? "backend unavailable"}. Assign a local Whisper model or a backend that serves the OpenAI audio transcription API (whisper-server, speaches, vLLM).`,
        );
        return null;
      }
      {
        const options = {
          url: resolved.url,
          apiPathPrefix: resolved.apiPathPrefix,
          model: resolved.model,
          apiKey: deps.getBackendApiKey?.(resolved.backendKey),
          allowRemoteInference: resolved.allowRemoteInference,
          maxChunkSeconds: resolved.transcription?.maxChunkSeconds,
          fetchFn: deps.fetchFn,
          decodeAudio: deps.decodeAudio,
        };
        // The protocol the operator set, else the one the transcription probe
        // found the backend answers on; the transcription API when neither.
        return resolved.transcription?.protocol === "chat-audio"
          ? new ChatAudioTranscriber(options)
          : new HttpTranscriber(options);
      }
    case "anthropic":
      log.warn(
        "Anthropic does not offer a transcription model — assign a local Whisper model or an HTTP transcription backend.",
      );
      return null;
    case "codex":
      log.warn(
        "Codex does not provide an audio-transcription backend — assign a local Whisper model or an HTTP transcription backend.",
      );
      return null;
    case "claude-code":
      log.warn(
        "Claude Code does not provide an audio-transcription backend — assign a local Whisper model or an HTTP transcription backend.",
      );
      return null;
    case "disabled":
    case "unresolved":
    case "typesafe":
      return null;
    default:
      return assertNever(resolved);
  }
}
