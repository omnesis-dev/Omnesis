// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Main-thread proxy for the build-embedder worker (epic #1011, graceful swap
 * for a LOCAL target).
 *
 * Implements the indexer `Embedder` interface so the main-thread
 * `GenerationBuilder` can re-embed the corpus through it exactly as it would an
 * `HttpEmbedder` — but under the hood every `embed()` / `embedQuery()` round-
 * trips to a short-lived worker that hosts the local GGUF model. This is what
 * makes the graceful path embedder-kind-agnostic on the TARGET side: a local
 * in-process model would block the gateway event loop if embedded on the main
 * thread, so we host it off-thread and keep live search responsive on the
 * still-active old generation while the new one builds.
 *
 * Lifecycle: constructed when a local-target graceful build begins; serves the
 * builder's batch `embed()` calls during the build/catch-up; doubles as the
 * NEW-model query embedder bridge across the atomic flip (its `embedQuery`
 * answers on the new index until the fresh steady-state indexer worker takes
 * over); then `dispose()`d. `dispose()` is also the abort/teardown path — a
 * newer swap aborting the in-flight build disposes this proxy, which shuts the
 * worker down cleanly (no leaked thread, no orphaned model).
 */

import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import { PendingRequest } from "./pending-request.js";
import type { EmbedderEncoding } from "../indexer/embedder-prefixes.js";
import type { Embedder } from "../indexer/types.js";
import type { BuildEmbedderInit, BuildEmbedderToMain, MainToBuildEmbedder } from "./protocol.js";

const log = createLogger("gateway:build-embedder");

export interface BuildWorkerEmbedderOptions {
  modelPath: string;
  embedDim: number;
  encoding: EmbedderEncoding;
  embedConcurrency: number;
  embedderContextSize: number;
  embedderTimeoutMs: number;
  embedderMaxInputChars: number;
}

// A batch embed of up to a few thousand chunks can take minutes on a cold local
// model; the timeout exists to bound a wedged native call, not to cap a normal
// build batch. A query embed reuses the same generous ceiling — it is rare and
// only used as the post-flip bridge.
const EMBED_TIMEOUT_MS = 10 * 60_000;

export class BuildWorkerEmbedder implements Embedder {
  private worker: Worker;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;
  private nextId = 1;
  private pendingEmbed = new Map<number, PendingRequest<Float32Array[]>>();
  private pendingQuery = new Map<number, PendingRequest<Float32Array>>();
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;

  constructor(opts: BuildWorkerEmbedderOptions) {
    // Source mode runs the .ts entry under tsx (preloading register-tsx.mjs so
    // the worker's `.js` specifiers resolve back to `.ts`); compiled mode runs
    // the emitted dist sibling directly.
    const entry = resolveWorkerEntry(
      "./build-embedder-worker.ts",
      import.meta.url,
      "./register-tsx.mjs",
    );
    this.worker = new Worker(entry.url, { execArgv: entry.execArgv });
    this.worker.on("message", (msg: BuildEmbedderToMain) => this.handleMessage(msg));
    this.worker.on("error", (err) => {
      log.error(`build-embedder worker error: ${err.message ?? String(err)}`);
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const init: BuildEmbedderInit = {
      type: "init",
      modelPath: opts.modelPath,
      embedDim: opts.embedDim,
      embedderEncoding: opts.encoding,
      embedConcurrency: opts.embedConcurrency,
      embedderContextSize: opts.embedderContextSize,
      embedderTimeoutMs: opts.embedderTimeoutMs,
      embedderMaxInputChars: opts.embedderMaxInputChars,
    };
    this.post(init);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ready;
    if (texts.length === 0) return [];
    const id = this.nextId++;
    const req = new PendingRequest<Float32Array[]>(EMBED_TIMEOUT_MS, () => {
      const p = this.pendingEmbed.get(id);
      if (p && this.pendingEmbed.delete(id)) {
        p.fail(new Error(`build embed timed out after ${EMBED_TIMEOUT_MS}ms`));
      }
    });
    this.pendingEmbed.set(id, req);
    this.post({ type: "embed", id, texts });
    return req.promise;
  }

  async embedQuery(query: string): Promise<Float32Array> {
    await this.ready;
    const id = this.nextId++;
    const req = new PendingRequest<Float32Array>(EMBED_TIMEOUT_MS, () => {
      const p = this.pendingQuery.get(id);
      if (p && this.pendingQuery.delete(id)) {
        p.fail(new Error(`build embedQuery timed out after ${EMBED_TIMEOUT_MS}ms`));
      }
    });
    this.pendingQuery.set(id, req);
    this.post({ type: "embedQuery", id, text: query });
    return req.promise;
  }

  async dispose(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
    this.post({ type: "shutdown" });

    // Fallback: terminate ourselves if the worker doesn't ack within 5s so a
    // wedged native embed can't block the swap's teardown.
    const fallback = setTimeout(() => {
      log.warn("build-embedder worker shutdown timed out — terminating");
      try {
        this.worker.terminate();
      } catch {
        /* best-effort */
      }
      if (this.shutdownResolve) this.shutdownResolve();
    }, 5_000);
    fallback.unref?.();

    await this.shutdownPromise;
    clearTimeout(fallback);

    // Reject anything still in flight so an aborted build's pending embed
    // doesn't leak a promise.
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new Error("build embedder disposed before ready"));
    }
    for (const [, p] of this.pendingEmbed) p.fail(new Error("build embedder shut down"));
    this.pendingEmbed.clear();
    for (const [, p] of this.pendingQuery) p.fail(new Error("build embedder shut down"));
    this.pendingQuery.clear();
  }

  private post(msg: MainToBuildEmbedder): void {
    this.worker.postMessage(msg);
  }

  private handleMessage(msg: BuildEmbedderToMain): void {
    switch (msg.type) {
      case "ready":
        if (!this.readySettled) {
          this.readySettled = true;
          this.resolveReady();
        }
        log.info("build-embedder worker ready");
        break;
      case "initError":
        if (!this.readySettled) {
          this.readySettled = true;
          this.rejectReady(new Error(msg.error));
        }
        break;
      case "log": {
        const child = createLogger(msg.component);
        child[msg.level](msg.message);
        break;
      }
      case "embedResult": {
        const pending = this.pendingEmbed.get(msg.id);
        if (pending) {
          this.pendingEmbed.delete(msg.id);
          pending.settle(msg.vectors.map((v) => new Float32Array(v)));
        }
        break;
      }
      case "embedError": {
        const pending = this.pendingEmbed.get(msg.id);
        if (pending) {
          this.pendingEmbed.delete(msg.id);
          pending.fail(new Error(msg.error));
        }
        break;
      }
      case "embedQueryResult": {
        const pending = this.pendingQuery.get(msg.id);
        if (pending) {
          this.pendingQuery.delete(msg.id);
          pending.settle(new Float32Array(msg.vector));
        }
        break;
      }
      case "embedQueryError": {
        const pending = this.pendingQuery.get(msg.id);
        if (pending) {
          this.pendingQuery.delete(msg.id);
          pending.fail(new Error(msg.error));
        }
        break;
      }
      case "shutdownComplete":
        try {
          this.worker.terminate();
        } catch {
          /* best-effort */
        }
        if (this.shutdownResolve) this.shutdownResolve();
        break;
    }
  }
}
