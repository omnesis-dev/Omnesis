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
 *
 * The HTTP route (`/inference/transcribe`) is the only caller; it owns the
 * experimental gate and request-size limit. This service is pure
 * capability+lifecycle infra.
 */

import { createLogger, assertNever } from "@omnesis/core";
import { loadTranscriberFromResolved, type LoadTranscriberDeps } from "./loader.js";
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
    case "disabled":
      return "disabled";
    case "unresolved":
      return "unresolved";
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
   * Transcribe audio bytes. Returns null when no transcriber is configured or
   * loadable, AND when the transcription itself fails — a worker crash
   * (whisper.cpp segfault), a timeout, or a decode/inference error. The caller
   * (the route) maps null to `{ available: false }`, which the collector treats
   * as "no transcript yet" and leaves the note to retry on a later sync. A
   * failed transcription must NEVER propagate as a throw: the worker runs in an
   * isolated subprocess precisely so its crash can't take the gateway down, and
   * surfacing it as a 5xx would defeat that — the supervisor already respawns
   * the worker for the next call.
   */
  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: { language?: string },
  ): Promise<TranscriptionResult | null> {
    // Resolve/load the capability AND run the transcription inside the same
    // serialization fence. A model reassignment disposes the previous
    // capability (kills its worker subprocess); doing that resolution inside the
    // fence guarantees no earlier-queued transcription is still running on the
    // old worker when it's torn down.
    return this.serialize(async () => {
      const capability = await this.ensureCapability();
      if (!capability) return null;
      try {
        return await capability.transcribe(audio, mimeType, opts);
      } catch (err) {
        log.warn(
          `Transcription failed (will retry on a later sync): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    });
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
