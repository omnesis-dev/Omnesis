// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the transcriber capability lifecycle for the gateway.
 *
 * - Resolves the `transcriber` assignment lazily and caches the loaded
 *   capability, reloading (and disposing the old one) when the assignment
 *   changes — so switching the Whisper model from the portal takes effect on
 *   the next transcription without a gateway restart.
 * - Serializes transcriptions: Whisper is CPU/GPU-heavy, so running one at a
 *   time avoids thrashing the model runner under concurrent voice notes.
 * - Orders the queue in two lanes. A person waiting on dictation
 *   (`"interactive"`) goes ahead of every queued source voice note
 *   (`"background"`), so a sync backlog never delays the text a person is
 *   waiting to see. A transcription already running is never interrupted.
 *
 * Callers are the HTTP routes — `/inference/transcribe` for source audio and
 * `/dictation/transcribe` for the mobile apps — which own their gates and
 * request-size limits. This service is pure capability+lifecycle infra.
 */

import { createLogger, assertNever } from "@omnesis/core";
import { loadTranscriberFromResolved, type LoadTranscriberDeps } from "./loader.js";
import { whisperDepsAvailable } from "./whisper-transcriber.js";
import type { ResolvedAssignment, TranscribeCapability, TranscriptionResult } from "@omnesis/core";

const log = createLogger("gateway:transcribe");

/** Reject audio larger than this. Voice notes are tiny; this guards against abuse. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Stable signature for a resolved assignment, to detect config changes. */
function signatureOf(resolved: ResolvedAssignment): string {
  switch (resolved.kind) {
    case "local":
      return `local:${resolved.catalogId}:${resolved.modelPath}:${resolved.available}`;
    case "replay":
      return `replay:${resolved.fixture ?? ""}`;
    case "http":
      return `http:${resolved.backendKey}:${resolved.model}:${resolved.available}`;
    case "anthropic":
      return `anthropic:${resolved.catalogId}:${resolved.available}`;
    case "codex":
      return `codex:${resolved.model}:${resolved.available}`;
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

/** Queue lane for a transcription. See the module comment. */
export type TranscriptionPriority = "interactive" | "background";

interface QueuedJob {
  run: () => Promise<void>;
  /** Settle without running, for a job whose caller has gone away. */
  abandon: () => void;
  signal?: AbortSignal;
}

/** Whether the assigned transcriber can run, and why not when it cannot. */
export interface TranscriberReadiness {
  runnable: boolean;
  reason?: string;
}

const LOCAL_RUNTIME_MISSING =
  "Local transcription needs the smart-whisper and ffmpeg-static optional dependencies.";

/**
 * Readiness of a resolved assignment by what `loadTranscriberFromResolved`
 * accepts, before the local runtime is considered: transcription is local-only,
 * so a remote backend never counts.
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
    case "anthropic":
    case "codex":
      return { runnable: false, reason: "Transcription runs on local models only." };
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
  private readonly lanes: Record<TranscriptionPriority, QueuedJob[]> = {
    interactive: [],
    background: [],
  };
  private running = false;
  /** Result of probing the local Whisper runtime; null until the probe settles. */
  private localRuntime: boolean | null = null;
  private probing: Promise<void> | null = null;

  constructor(opts: { resolveAssignment: () => ResolvedAssignment; deps?: LoadTranscriberDeps }) {
    this.resolveAssignment = opts.resolveAssignment;
    this.deps = opts.deps ?? {};
  }

  private async ensureCapability(): Promise<TranscribeCapability | null> {
    const resolved = this.resolveAssignment();
    const signature = signatureOf(resolved);
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
   * one-off probe for it and reports runnable until the probe says otherwise,
   * so a status poll never waits on it.
   */
  readiness(): TranscriberReadiness {
    const resolved = this.resolveAssignment();
    const readiness = assignmentReadiness(resolved);
    if (!readiness.runnable || resolved.kind !== "local") return readiness;
    if (this.localRuntime === null) {
      this.probing ??= whisperDepsAvailable(this.deps.loadModule).then((available) => {
        this.localRuntime = available;
      });
      return readiness;
    }
    return this.localRuntime ? readiness : { runnable: false, reason: LOCAL_RUNTIME_MISSING };
  }

  /** Interactive transcriptions waiting behind the running one. */
  interactiveBacklog(): number {
    return this.lanes.interactive.length;
  }

  /**
   * Transcribe audio bytes. Returns null when no transcriber is configured or
   * loadable, AND when the transcription itself fails — a worker crash
   * (whisper.cpp segfault), a timeout, or a decode/inference error. The caller
   * (the route) maps null to `{ available: false }`, which the collector treats
   * as "no transcript yet" and leaves the note to retry on a later sync. A
   * failed transcription must NEVER propagate as a throw: the worker runs in an
   * isolated subprocess precisely so its crash can't take the gateway down, and
   * surfacing it as a 5xx would defeat that — the supervisor already respawns
   * the worker for the next call.
   *
   * `signal` marks the caller as gone: a job whose signal has aborted by the
   * time it reaches the front of the queue returns null without running.
   */
  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: { language?: string; priority?: TranscriptionPriority; signal?: AbortSignal },
  ): Promise<TranscriptionResult | null> {
    const language = opts?.language;
    // Resolve/load the capability AND run the transcription inside the same
    // serialization fence. A model reassignment disposes the previous
    // capability (kills its worker subprocess); doing that resolution inside the
    // fence guarantees no earlier-queued transcription is still running on the
    // old worker when it's torn down.
    const priority = opts?.priority ?? "background";
    return this.enqueue(priority, opts?.signal, null, async () => {
      const capability = await this.ensureCapability();
      if (!capability) return null;
      try {
        return await capability.transcribe(
          audio,
          mimeType,
          language !== undefined ? { language } : undefined,
        );
      } catch (err) {
        log.warn(
          `Transcription failed (${priority}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    });
  }

  /**
   * Run `fn` once nothing else is running and every job queued ahead of it in
   * its lane, plus every queued interactive job, has run. A job whose `signal`
   * aborted while it waited settles with `abandoned` instead.
   */
  private enqueue<T>(
    priority: TranscriptionPriority,
    signal: AbortSignal | undefined,
    abandoned: T,
    fn: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.lanes[priority].push({
        run: () => Promise.resolve().then(fn).then(resolve, reject),
        abandon: () => resolve(abandoned),
        signal,
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    let next: QueuedJob | undefined;
    while ((next = this.lanes.interactive.shift() ?? this.lanes.background.shift())) {
      if (!next.signal?.aborted) break;
      next.abandon();
    }
    if (!next) return;
    this.running = true;
    void next.run().finally(() => {
      this.running = false;
      this.pump();
    });
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
