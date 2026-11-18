// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build-embedder worker (graceful swap for a LOCAL target).
 *
 * Hosts a single LOCAL (node-llama-cpp) embedder so a graceful double-buffered
 * rebuild whose TARGET model is local runs OFF the gateway event loop. The
 * main-thread `GenerationBuilder` re-embeds the corpus through the
 * `BuildWorkerEmbedder` proxy; routing those CPU/GPU-bound embeds here keeps
 * live search responsive on the still-active old generation while the new one
 * builds.
 *
 * Deliberately minimal versus the steady-state indexer worker: NO DB handle, NO
 * indexing cycle, NO chunker — just `embed` / `embedQuery`. It is spawned when a
 * local-target graceful build begins and disposed right after the atomic flip
 * repoints query embedding to the fresh steady-state worker, so at most one
 * extra model copy is resident, and only for the build window.
 *
 * Comms with main (see `protocol.ts`):
 *   init → ready (after the model loads + a warmup embed)
 *   embed{id,texts} → embedResult{id,vectors} | embedError{id,error}
 *   embedQuery{id,text} → embedQueryResult{id,vector} | embedQueryError{id,error}
 *   shutdown → drain calls → dispose model → shutdownComplete → close port
 */

import { parentPort } from "node:worker_threads";
import { LlamaCppEmbedder } from "../indexer/embedder.js";
import type {
  BuildEmbedderInit,
  BuildEmbedderToMain,
  LogLevel,
  MainToBuildEmbedder,
} from "./protocol.js";

if (!parentPort) {
  throw new Error("build-embedder-worker must be run as a Node worker_thread");
}

function post(msg: BuildEmbedderToMain): void {
  parentPort!.postMessage(msg);
}

function log(level: LogLevel, message: string): void {
  post({ type: "log", level, component: "build-embedder-worker", message });
}

let embedder: LlamaCppEmbedder | null = null;
let shuttingDown = false;
const active = new Set<Promise<void>>();

function track(operation: Promise<void>): void {
  active.add(operation);
  void operation.then(
    () => active.delete(operation),
    () => active.delete(operation),
  );
}

async function handleInit(init: BuildEmbedderInit): Promise<void> {
  if (embedder) {
    log("warn", "init received twice — ignoring");
    return;
  }
  try {
    const e = new LlamaCppEmbedder(init.modelPath, {
      concurrency: init.embedConcurrency,
      contextSize: init.embedderContextSize,
      timeoutMs: init.embedderTimeoutMs,
      maxInputChars: init.embedderMaxInputChars,
      encoding: init.embedderEncoding,
      outputDim: init.embedDim,
    });
    embedder = e;
    // Warmup forces the (slow) model load now so `ready` means "embeds will be
    // fast", and a load failure surfaces as initError instead of failing the
    // first build batch mid-pass.
    await e.embed(["warmup"]);
    if (shuttingDown) return;
    log("info", `build embedder ready: model=${init.modelPath} dim=${init.embedDim}`);
    post({ type: "ready" });
  } catch (err) {
    try {
      await embedder?.dispose();
      embedder = null;
    } catch {
      /* Preserve the initialization failure after cleanup. */
    }
    post({ type: "initError", error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleEmbed(id: number, texts: string[]): Promise<void> {
  if (!embedder) {
    post({ type: "embedError", id, error: "build embedder not ready" });
    return;
  }
  try {
    const vectors = await embedder.embed(texts);
    post({ type: "embedResult", id, vectors: vectors.map((v) => Array.from(v)) });
  } catch (err) {
    post({ type: "embedError", id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleEmbedQuery(id: number, text: string): Promise<void> {
  if (!embedder) {
    post({ type: "embedQueryError", id, error: "build embedder not ready" });
    return;
  }
  try {
    const vector = await embedder.embedQuery(text);
    post({ type: "embedQueryResult", id, vector: Array.from(vector) });
  } catch (err) {
    post({ type: "embedQueryError", id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled(active);
  if (embedder) {
    try {
      await embedder.dispose();
    } catch (error) {
      log(
        "error",
        `native cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Without confirmed native disposal, terminating this thread is unsafe.
      return;
    }
    embedder = null;
  }
  post({ type: "shutdownComplete" });
  parentPort!.close();
}

parentPort.on("message", (msg: MainToBuildEmbedder) => {
  if (shuttingDown) return;
  switch (msg.type) {
    case "init":
      track(handleInit(msg));
      break;
    case "embed":
      track(handleEmbed(msg.id, msg.texts));
      break;
    case "embedQuery":
      track(handleEmbedQuery(msg.id, msg.text));
      break;
    case "shutdown":
      void handleShutdown();
      break;
  }
});
