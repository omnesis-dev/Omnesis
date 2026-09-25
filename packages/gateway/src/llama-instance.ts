// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared singleton for node-llama-cpp module import + getLlama() instance.
 *
 * node-llama-cpp uses top-level await internally, which can cause TDZ errors
 * if two call sites trigger `await import("node-llama-cpp")` concurrently.
 * This module serializes the import so only one dynamic import runs at a time.
 *
 * The exported `Llama` type is the typed handle node-llama-cpp returns from
 * `getLlama()`. Re-exporting it here means consumer modules
 * (`indexer/embedder.ts`, `search/models/llama-cpp.ts`) get a typed
 * instance and can drop the `as { loadModel: ... }` casts that used to
 * bridge the old `Promise<unknown>` return shape.
 */

import type { Llama } from "node-llama-cpp";
export type { Llama } from "node-llama-cpp";

let llamaModulePromise: Promise<typeof import("node-llama-cpp")> | null = null;
let llamaInstancePromise: Promise<Llama> | null = null;

/**
 * Get the node-llama-cpp module (cached after first load).
 */
export function getLlamaModule(): Promise<typeof import("node-llama-cpp")> {
  if (!llamaModulePromise) {
    llamaModulePromise = import("node-llama-cpp");
  }
  return llamaModulePromise;
}

/**
 * Whether the local node-llama-cpp build should run on CPU only. Set
 * `OMNESIS_LLAMA_GPU=false` (or `0`/`off`/`no`) on hosts where a CUDA
 * allocation can fail under memory pressure — e.g. a shared unified-memory
 * box where other processes (a vLLM server, another model) have already
 * reserved most of the pool. A failed allocation aborts the whole process
 * via ggml's `GGML_ABORT`, so forcing CPU trades throughput for stability.
 * Unset = let node-llama-cpp pick the best available backend (the normal
 * path: Metal on Apple Silicon, CUDA elsewhere).
 */
function gpuDisabled(): boolean {
  const v = process.env.OMNESIS_LLAMA_GPU?.trim().toLowerCase();
  return v === "false" || v === "0" || v === "off" || v === "no";
}

/**
 * Get the shared Llama instance (cached after first load).
 */
export async function getLlamaInstance(): Promise<Llama> {
  if (!llamaInstancePromise) {
    llamaInstancePromise = getLlamaModule().then(async (llama) => {
      // CPU-forced path deliberately bypasses the "lastBuild" fast path: that
      // cached build may be a GPU build, which is exactly what we're avoiding.
      if (gpuDisabled()) return llama.getLlama({ gpu: false });
      try {
        return await llama.getLlama("lastBuild");
      } catch {
        return llama.getLlama();
      }
    });
  }
  return llamaInstancePromise;
}
