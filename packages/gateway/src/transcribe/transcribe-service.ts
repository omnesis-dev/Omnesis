// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the transcriber capability lifecycle for the gateway.
 *
 * - Resolves the `transcriber` assignment lazily and caches the loaded
 *   capability, reloading (and disposing the old one) when the assignment
 *   changes — so switching the transcriber from the portal takes effect on
 *   the next transcription without a gateway restart.
 * - Serializes transcriptions: speech recognition is CPU/GPU-heavy, so running
 *   one at a time avoids thrashing the model runner under concurrent voice
 *   notes. A queued transcription whose caller stopped waiting is skipped.
 *
 * Callers are the `/inference/transcribe` route (source audio from the
 * collector) and the voice-note queue (Tell Omnesis recordings); each owns its
 * own gate and request-size limit. This service is pure capability+lifecycle
 * infra.
 */

import { createHash } from "node:crypto";
import { createLogger, assertNever } from "@omnesis/core";
import { loadTranscriberFromResolved, type LoadTranscriberDeps } from "./loader.js";
import { whisperDepsAvailable } from "./whisper-transcriber.js";
import type {
  CapabilityVerdict,
  ResolvedAssignment,
  TranscribeCapability,
  TranscriptionResult,
  TranscriptionContext,
  TranscriptionVocabulary,
} from "@omnesis/core";

const log = createLogger("gateway:transcribe");

/** Reject audio larger than this. Voice notes are tiny; this guards against abuse. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** An unavailable capability is distinct from a failed recording or cancelled caller. */
export type TranscriptionOutcome =
  | { kind: "transcribed"; result: TranscriptionResult }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "cancelled" };

export interface TranscribeOptions {
  language?: string;
  minTimeoutMs?: number;
  context?: TranscriptionContext;
  allowVocabulary?: boolean;
  /** Aborted when the caller stops waiting; queued work it covers is skipped. */
  signal?: AbortSignal;
}

/**
 * How long a transcription waits for its vocabulary hints. The lookup is a
 * bounded indexed read at user priority on the io worker (a 200 ms latency
 * budget), which may first wait for a running background read (up to 2 s).
 * Past this, the clip is transcribed without hints rather than holding the
 * queue behind a slow or stuck io worker.
 */
export const VOCABULARY_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Stable signature for a resolved assignment, to detect config changes. The
 * http arm folds in everything a backend edit can change under the same
 * backendKey — url, path prefix, the egress flag and an API-key fingerprint —
 * so moving or re-keying a transcription server reloads the transcriber.
 */
function signatureOf(resolved: ResolvedAssignment, apiKey: string | undefined): string {
  switch (resolved.kind) {
    case "local":
      return `local:${resolved.catalogId}:${resolved.modelPath}:${resolved.available}`;
    case "replay":
      return `replay:${resolved.fixture ?? ""}`;
    case "http": {
      const keyPrint = createHash("sha256")
        .update(apiKey ?? "")
        .digest("hex")
        .slice(0, 8);
      return `http:${resolved.backendKey}:${resolved.url}:${resolved.apiPathPrefix ?? ""}:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}:${keyPrint}`;
    }
    case "anthropic":
      return `anthropic:${resolved.catalogId}:${resolved.available}`;
    case "codex":
      return `codex:${resolved.model}:${resolved.available}`;
    case "claude-code":
      return `claude-code:${resolved.model}:${resolved.available}`;
    case "typesafe":
      return `typesafe:${resolved.model}:${resolved.available}`;
    case "disabled":
      return "disabled";
    case "unresolved":
      return "unresolved";
    default:
      return assertNever(resolved);
  }
}

/**
 * Verify the assigned transcriber's HTTP backend by transcribing one second of
 * audio, and say in one log line what the operator should do about a backend
 * that cannot. Runs after the boot probe and after a config change touching
 * the assignment or a backend; a local or unset assignment verifies nothing.
 */
export async function verifyTranscriberAssignment(registry: {
  verifyAssignedTranscriber(): Promise<CapabilityVerdict | null>;
}): Promise<void> {
  const verdict = await registry.verifyAssignedTranscriber();
  if (!verdict) return;
  if (verdict.supported) {
    log.info(`Transcriber backend verified for ${verdict.model}: ${verdict.detail}`);
  } else if (verdict.inconclusive) {
    log.warn(
      `Could not confirm the transcriber backend for ${verdict.model} yet: ${verdict.detail}. Voice notes wait until it answers.`,
    );
  } else {
    log.warn(
      `The assigned transcriber cannot transcribe: ${verdict.detail}. Voice notes are not transcribed until the transcriber role is assigned a local Whisper model or a backend that serves the OpenAI audio transcription API (see docs/transcription.md).`,
    );
  }
}

/** Whether the assigned transcriber can run, and why not when it cannot. */
export interface TranscriberReadiness {
  runnable: boolean;
  reason?: string;
}

const LOCAL_RUNTIME_CHECKING = "Checking for the local transcription runtime.";
const LOCAL_RUNTIME_MISSING =
  "Local transcription needs the smart-whisper and ffmpeg-static optional dependencies.";

/**
 * Readiness of a resolved assignment by what `loadTranscriberFromResolved`
 * accepts, before the local runtime is considered. An HTTP backend is ready
 * when its probe found it reachable; the inference URL policy has already
 * refused one the operator has not allowed.
 */
export function assignmentReadiness(resolved: ResolvedAssignment): TranscriberReadiness {
  switch (resolved.kind) {
    case "local":
      return resolved.available
        ? { runnable: true }
        : { runnable: false, reason: resolved.reason ?? "The transcriber model is not installed." };
    case "replay":
      return { runnable: true };
    case "http":
      if (!resolved.model) {
        return { runnable: false, reason: "The transcription backend assignment has no model." };
      }
      return resolved.available
        ? { runnable: true }
        : {
            runnable: false,
            reason: resolved.reason ?? "The transcription backend is not reachable.",
          };
    case "anthropic":
    case "codex":
    case "claude-code":
    case "typesafe":
      return {
        runnable: false,
        reason:
          "This backend offers no transcription model. Assign a local Whisper model or an HTTP transcription backend.",
      };
    case "disabled":
      return { runnable: false, reason: "No transcriber model is assigned." };
    case "unresolved":
      return { runnable: false, reason: resolved.reason };
    default:
      return assertNever(resolved);
  }
}

export class TranscribeService {
  private readonly resolveAssignment: () => ResolvedAssignment;
  private readonly deps: LoadTranscriberDeps;
  private current: { signature: string; capability: TranscribeCapability | null } | null = null;
  private loading: Promise<TranscribeCapability | null> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** Result of probing the local Whisper runtime; null until the probe settles. */
  private localRuntime: boolean | null = null;
  private probing: Promise<void> | null = null;
  private readonly vocabulary?: {
    enabled(): boolean;
    getDictionary(context: TranscriptionContext): Promise<TranscriptionVocabulary>;
    maxPromptTokens(): number;
  };

  constructor(opts: {
    resolveAssignment: () => ResolvedAssignment;
    deps?: LoadTranscriberDeps;
    vocabulary?: TranscribeService["vocabulary"];
  }) {
    this.resolveAssignment = opts.resolveAssignment;
    this.deps = opts.deps ?? {};
    this.vocabulary = opts.vocabulary;
  }

  private async ensureCapability(): Promise<TranscribeCapability | null> {
    const resolved = this.resolveAssignment();
    const signature = signatureOf(
      resolved,
      resolved.kind === "http" ? this.deps.getBackendApiKey?.(resolved.backendKey) : undefined,
    );
    if (this.current && this.current.signature === signature) {
      return this.current.capability;
    }
    if (this.loading) return this.loading;

    // Assignment changed (or first use) — dispose the old capability and load anew.
    const previous = this.current?.capability ?? null;
    this.loading = (async () => {
      if (previous) await previous.dispose().catch(() => {});
      const capability = await loadTranscriberFromResolved(resolved, this.deps);
      this.current = { signature, capability };
      return capability;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Whether a transcription could run now, without loading anything. A local
   * assignment also needs the optional Whisper runtime; the first call starts a
   * one-off probe for it and reports not runnable until the probe confirms the
   * runtime, so a status poll never waits on it and never advertises a
   * runtime nobody has seen yet.
   */
  readiness(): TranscriberReadiness {
    const resolved = this.resolveAssignment();
    const readiness = assignmentReadiness(resolved);
    if (!readiness.runnable || resolved.kind !== "local") return readiness;
    if (this.localRuntime === null) {
      this.probeLocalRuntime();
      return { runnable: false, reason: LOCAL_RUNTIME_CHECKING };
    }
    return this.localRuntime ? readiness : { runnable: false, reason: LOCAL_RUNTIME_MISSING };
  }

  /**
   * The readiness once the Whisper runtime probe, if one is needed, has
   * settled. For callers that are already waiting on a request or a queue
   * pass, where a few milliseconds beat a wrong "not yet".
   */
  async settledReadiness(): Promise<TranscriberReadiness> {
    const readiness = this.readiness();
    if (this.probing && this.localRuntime === null) {
      await this.probing;
      return this.readiness();
    }
    return readiness;
  }

  private probeLocalRuntime(): void {
    this.probing ??= whisperDepsAvailable(this.deps.loadModule).then((available) => {
      this.localRuntime = available;
    });
  }

  /** Best-effort transcription for callers that own their retry policy. */
  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionResult | null> {
    const outcome = await this.transcribeOutcome(audio, mimeType, opts);
    return outcome.kind === "transcribed" ? outcome.result : null;
  }

  /** Preserve failure classification for source audio and its backlog notices. */
  async transcribeOutcome(
    audio: Uint8Array,
    mimeType: string,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionOutcome> {
    // Resolve/load the capability AND run the transcription inside the same
    // serialization fence. A model reassignment disposes the previous
    // capability (kills its worker subprocess); doing that resolution inside the
    // fence guarantees no earlier-queued transcription is still running on the
    // old worker when it's torn down.
    return this.serialize(async () => {
      // A caller that gave up while this waited in the queue gets nothing from
      // running it; skipping it keeps the transcriber free for work someone
      // still wants.
      if (opts?.signal?.aborted) {
        log.info("Skipped a queued transcription whose caller stopped waiting");
        return { kind: "cancelled" };
      }
      const capability = await this.ensureCapability();
      if (!capability) return { kind: "unavailable" };
      try {
        let vocabulary: TranscriptionVocabulary | undefined;
        if (
          opts?.allowVocabulary !== false &&
          capability.vocabularyRuntime &&
          this.vocabulary?.enabled()
        ) {
          vocabulary = await this.lookupVocabulary(
            this.vocabulary,
            opts?.context ?? {
              purpose: "source-audio",
              ...(opts?.language ? { languageHints: [opts.language] } : {}),
            },
            opts?.signal,
          );
        }
        if (opts?.signal?.aborted) {
          log.info("Skipped a transcription whose caller stopped waiting");
          return { kind: "cancelled" };
        }
        const result = await capability.transcribe(audio, mimeType, {
          ...(opts?.language ? { language: opts.language } : {}),
          ...(opts?.minTimeoutMs !== undefined ? { minTimeoutMs: opts.minTimeoutMs } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(vocabulary && this.vocabulary?.enabled()
            ? {
                vocabulary,
                maxPromptTokens: this.vocabulary.maxPromptTokens(),
              }
            : {}),
        });
        return { kind: "transcribed", result };
      } catch (err) {
        if (opts?.signal?.aborted) {
          log.info("Stopped a transcription whose caller stopped waiting");
          return { kind: "cancelled" };
        }
        log.warn(
          `Transcription failed (will retry on a later sync): ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "failed" };
      }
    });
  }

  /**
   * The vocabulary hints for one transcription, or none when the lookup fails,
   * outlasts `VOCABULARY_LOOKUP_TIMEOUT_MS` or loses its caller. Hints are an
   * enhancement, never a reason to hold the queue.
   */
  private async lookupVocabulary(
    vocabulary: NonNullable<TranscribeService["vocabulary"]>,
    context: TranscriptionContext,
    signal: AbortSignal | undefined,
  ): Promise<TranscriptionVocabulary | undefined> {
    if (signal?.aborted) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const lookup = vocabulary.getDictionary(context);
      // An abandoned lookup settles unobserved: its result belonged to this call alone.
      lookup.catch(() => {});
      return await Promise.race([
        lookup,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            log.warn(
              `Vocabulary lookup took over ${VOCABULARY_LOOKUP_TIMEOUT_MS}ms; transcribing without hints`,
            );
            resolve(undefined);
          }, VOCABULARY_LOOKUP_TIMEOUT_MS);
          onAbort = () => resolve(undefined);
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch {
      // An unavailable read worker must not lose audio.
      log.warn("Vocabulary lookup unavailable; transcribing without hints");
      return undefined;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Run `fn` after all previously-queued transcriptions complete. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async dispose(): Promise<void> {
    const capability = this.current?.capability ?? null;
    this.current = null;
    if (capability) {
      await capability.dispose().catch((err) => {
        log.warn(
          `Failed to dispose transcriber: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}
