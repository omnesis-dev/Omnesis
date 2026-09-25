// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Embedder using node-llama-cpp with a GGUF embedding model.
 * Runs fully in-process with Metal acceleration on Apple Silicon.
 *
 * Uses a pool of N embedding contexts to parallelize across the GPU.
 * A single `LlamaEmbeddingContext` processes one input at a time
 * sequentially — each call pays CPU↔GPU round-trip overhead, so a
 * sequential loop underutilizes the GPU by 10–50×. Running multiple
 * contexts concurrently lets in-flight work overlap, saturating the
 * GPU at the cost of a few hundred MB of KV cache (contextSize × N).
 *
 * Concurrency comes in through the constructor (`opts.concurrency`).
 * The gateway resolves it from `OMNESIS_EMBED_CONCURRENCY` env
 * > `indexer.embedConcurrency` in omnesis.json > default 2, then
 * passes it to the indexer worker via init. Slot 0 is reserved for
 * `embedQuery` — the indexer's batch `embed()` only dispatches onto
 * slots 1..N-1, so an interactive search never queues behind a
 * 128-chunk indexing burst. With pool size 1 the dedicated slot
 * degrades to shared use (indexer and query share the single slot).
 */

import { createLogger } from "@omnesis/core";
import { getLlamaInstance } from "../llama-instance.js";
import {
  NO_EMBEDDER_PREFIXES,
  type EmbedderEncoding,
  type EmbedderPrefixes,
} from "./embedder-prefixes.js";
import type { LlamaEmbedding, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import type { Embedder } from "./types.js";

const log = createLogger("indexer:embedder");

// Built-in fallbacks for tests and direct callers that construct
// LlamaCppEmbedder without forwarding the resolved runtime settings.
// Production callers (the indexer worker) override these via opts:
//   - contextSize: nomic-embed-text-v1.5 supports up to 8192 tokens; the
//     chunker targets 2048 chars (~512 tokens). Keep headroom for the
//     occasional large chunk without ballooning per-context KV cache.
//   - maxInputChars: hard truncation bound, ~2048 tokens at 3 chars/token.
//   - timeoutMs: per-native-call wall-clock ceiling. A stalled GGUF
//     inference is the recurring root cause of full-gateway hangs (the
//     slot's busy chain never resolves and queued calls pile up). The
//     native call keeps running in the background; that's fine —
//     freshly-dispatched calls use a different slot.
const DEFAULT_CONTEXT_SIZE = 2048;
const DEFAULT_MAX_INPUT_CHARS = 2048 * 3;
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

// Concurrency is configured at boot and passed to the embedder's
// constructor via `opts.concurrency`. The indexer worker receives the
// resolved value (env > config > default) in its init message; see
// packages/gateway/src/mitigations.ts for the resolution rules.
// A small fallback is kept here for tests that construct LlamaCppEmbedder
// directly without opts.
const FALLBACK_CONCURRENCY = 2;

/** Single pool-owned context. Serializes calls against itself. */
interface EmbeddingSlot {
  ctx: LlamaEmbeddingContext;
  /** Promise chain so a second call on the same slot waits for the first. */
  busy: Promise<void>;
}

export class LlamaCppEmbedder implements Embedder {
  private model: LlamaModel | null = null;
  private slots: EmbeddingSlot[] = [];
  private contextSize: number;
  private concurrency: number;
  private timeoutMs: number;
  private maxInputChars: number;
  /**
   * Task-specific text prefixes prepended at embed-time. Resolved at boot
   * from the embedder's encoding (#718): a `text-prefix` encoding maps to
   * its query/document strings; `none` and `api-param` map to the no-op
   * (local GGUF has no HTTP body, so api-param can't apply here). See
   * `embedder-prefixes.ts`. The default is the empty-prefix no-op so callers
   * that pass neither `opts.encoding` nor `opts.prefixes` (tests, the
   * in-process fallbacks above) behave as before.
   */
  private prefixes: EmbedderPrefixes;
  private outputDim: number | undefined;
  private onLoadProgress: ((progress: number) => void) | undefined;
  private loadPromise: Promise<void> | null = null;

  constructor(
    private modelPath: string,
    opts?: {
      contextSize?: number;
      concurrency?: number;
      /** Per-native-call wall-clock ceiling, ms. */
      timeoutMs?: number;
      /** Hard truncation bound on input length, chars. */
      maxInputChars?: number;
      /**
       * Per-model retrieval encoding (#718). Only the `text-prefix` branch
       * has any effect locally; `none`/`api-param` are no-ops (local GGUF
       * has no request body to carry an API param). Takes precedence over
       * `prefixes`.
       */
      encoding?: EmbedderEncoding;
      /**
       * Legacy text-prefix option. Equivalent to passing
       * `{ kind: "text-prefix", ...prefixes }` as `encoding`. When omitted,
       * raw text is sent to the embedder on both sides — matches the
       * historical Omnesis behaviour and the safe default.
       */
      prefixes?: EmbedderPrefixes;
      /**
       * Truncate the model's native output to this many dimensions.
       * Used for MRL (Matryoshka Representation Learning) models that
       * output high-dimensional vectors but support clean truncation
       * to smaller dims with minimal quality loss.
       */
      outputDim?: number;
      /**
       * Called with 0–1 progress during model weight loading.
       * Forwarded directly to node-llama-cpp's `onLoadProgress`.
       */
      onLoadProgress?: (progress: number) => void;
    },
  ) {
    this.contextSize = opts?.contextSize ?? DEFAULT_CONTEXT_SIZE;
    this.concurrency = opts?.concurrency ?? FALLBACK_CONCURRENCY;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.maxInputChars = opts?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.prefixes = resolveLocalPrefixes(opts?.encoding, opts?.prefixes);
    this.outputDim = opts?.outputDim;
    this.onLoadProgress = opts?.onLoadProgress;
  }

  private truncate(vec: Float32Array): Float32Array {
    if (this.outputDim && vec.length > this.outputDim) {
      return vec.slice(0, this.outputDim);
    }
    return vec;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    log.info(`Loading embedding model: ${this.modelPath}`);
    const startMs = Date.now();

    const llamaInstance = await getLlamaInstance();
    this.model = await llamaInstance.loadModel({
      modelPath: this.modelPath,
      onLoadProgress: this.onLoadProgress,
    });

    const createCtx = this.model.createEmbeddingContext.bind(this.model);

    // Allocate contexts serially — node-llama-cpp's allocator isn't
    // safe under concurrent creation and a single context init stalls
    // for <100ms anyway. After this, inference runs fully parallel.
    for (let i = 0; i < this.concurrency; i++) {
      const ctx = await createCtx({ contextSize: this.contextSize });
      this.slots.push({ ctx, busy: Promise.resolve() });
    }

    log.info(
      `Embedding model loaded in ${Date.now() - startMs}ms ` +
        `(context size: ${this.contextSize}, pool: ${this.concurrency})`,
    );
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ensureLoaded();
    if (texts.length === 0) return [];

    // Fan out across the indexer slots (1..N-1), leaving slot 0 free
    // for embedQuery. Each slot's `busy` promise acts as a per-slot
    // lock — chaining work onto it serialises native calls that share
    // a single EmbeddingContext while still letting the pool run in
    // parallel across slots.
    //
    // Document-side prefix is applied here before the slot dispatch so
    // truncation in `runOnSlot` measures against the post-prefix
    // length — keeps the model from being cut off mid-prefix on
    // outlier inputs.
    const docPrefix = this.prefixes.document;
    const results = new Array<Float32Array>(texts.length);
    const tasks = texts.map((text, i) =>
      this.runOnSlot(
        pickIndexerSlotIndex(this.slots.length, i),
        docPrefix ? docPrefix + text : text,
        i,
        results,
      ),
    );
    await Promise.all(tasks);
    return results;
  }

  /**
   * Chain work onto `slots[slotIdx]`, write the resulting vector into
   * `results[resultIdx]`. A wall-clock timeout bounds every native call so a
   * wedged GGUF inference can't permanently lock the slot.
   *
   * This is a strict transport primitive: a context-size overflow throws and
   * is recovered by the resilient orchestrator (`resilient-embed.ts`), which
   * owns shrink-and-drop policy uniformly across both embedder backends.
   */
  private runOnSlot(
    slotIdx: number,
    rawText: string,
    resultIdx: number,
    results: Float32Array[],
  ): Promise<void> {
    const slot = this.slots[slotIdx];
    const timeoutMs = this.timeoutMs;
    const maxInputChars = this.maxInputChars;
    const next = slot.busy.then(async () => {
      const input = rawText.length > maxInputChars ? rawText.slice(0, maxInputChars) : rawText;
      const r = await embedWithTimeout(slot.ctx, input, timeoutMs);
      results[resultIdx] = this.truncate(new Float32Array(r.vector));
    });
    slot.busy = next.catch(() => {}); // keep chain alive even on failures
    return next;
  }

  async embedQuery(query: string): Promise<Float32Array> {
    await this.ensureLoaded();
    const queryPrefix = this.prefixes.query;
    const prefixed = queryPrefix ? queryPrefix + query : query;
    const results = new Array<Float32Array>(1);
    // Always run on slot 0 — reserved for interactive queries so they
    // don't queue behind an in-flight indexer batch on slots 1..N-1.
    await this.runOnSlot(0, prefixed, 0, results);
    return results[0];
  }

  async dispose(): Promise<void> {
    for (const slot of this.slots) {
      try {
        await slot.ctx.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.slots = [];
    if (this.model) {
      await this.model.dispose();
      this.model = null;
    }
    this.loadPromise = null;
    log.info("Embedding model disposed");
  }
}

/**
 * Reduce a per-model encoding (#718) to the text prefixes a local GGUF can
 * apply. Only the `text-prefix` branch maps to actual prefixes; `none` and
 * `api-param` (which local embedders can't carry) become the no-op. An
 * explicit `encoding` wins over the legacy `prefixes` option.
 */
function resolveLocalPrefixes(
  encoding: EmbedderEncoding | undefined,
  prefixes: EmbedderPrefixes | undefined,
): EmbedderPrefixes {
  if (encoding) {
    return encoding.kind === "text-prefix"
      ? { query: encoding.query, document: encoding.document }
      : NO_EMBEDDER_PREFIXES;
  }
  return prefixes ?? NO_EMBEDDER_PREFIXES;
}

/**
 * Round-robin across the indexer-owned slots (1..poolSize-1), leaving
 * slot 0 reserved for embedQuery. With poolSize <= 1 we have no spare
 * slot, so fall back to slot 0 (queries and indexing share).
 */
export function pickIndexerSlotIndex(poolSize: number, taskIndex: number): number {
  if (poolSize <= 1) return 0;
  return 1 + (taskIndex % (poolSize - 1));
}

/**
 * Race the native getEmbeddingFor call against a wall-clock timeout.
 * If the native call wedges (observed with very large inputs) the slot
 * still gets freed so the rest of the indexer keeps moving. The native
 * promise itself is left to settle whenever it does — node-llama-cpp
 * doesn't expose a cancellation primitive.
 */
function embedWithTimeout(
  ctx: LlamaEmbeddingContext,
  input: string,
  timeoutMs: number,
): Promise<LlamaEmbedding> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(new Error(`embedding timed out after ${timeoutMs}ms (input ${input.length} chars)`)),
      timeoutMs,
    );
  });
  return Promise.race([ctx.getEmbeddingFor(input), timeout]);
}
