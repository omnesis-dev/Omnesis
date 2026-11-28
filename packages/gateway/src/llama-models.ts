// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Load and free local llama.cpp models through one place, so a host where
 * freeing a model would crash the process keeps the model instead.
 *
 * On Windows, when the CPU has AMX, llama.cpp keeps quantized weights in its
 * AMX buffer type. That buffer is allocated with `_aligned_malloc` but freed
 * with plain `free` (`ggml/src/ggml-cpu/amx/amx.cpp`), which corrupts the
 * Windows heap and ends the process with STATUS_HEAP_CORRUPTION (0xC0000374).
 * Elsewhere aligned memory may be passed to `free`, so freeing is safe.
 * node-llama-cpp offers no way to keep llama.cpp off that buffer type.
 *
 * On such a host, {@link releaseLlamaModel} keeps the model loaded, and the
 * next {@link loadLlamaModel} of the same file with the same options takes it
 * back instead of loading another copy, so a model unloaded when idle and
 * loaded again costs no more memory. Contexts are still freed: their memory
 * is not in the AMX buffer.
 *
 * A worker thread that loaded a model on such a host must also outlive the
 * model: Node frees native objects when a worker thread ends, which frees the
 * weights the same way. {@link holdsUnfreeableLlamaModels} tells the worker to
 * stay alive after shutdown (see `workers/shutdown-worker.ts`).
 */

import { createLogger } from "@omnesis/core";
import { getLlamaInstance } from "./llama-instance.js";
import type { LlamaModel, LlamaModelOptions } from "node-llama-cpp";

const log = createLogger("gateway:llama");

/**
 * Whether freeing a model would corrupt the heap: llama.cpp's CPU backend
 * reports `AMX_INT8 = 1` exactly when it loaded its AMX variant, which it
 * does only on a CPU with AMX, and the mismatch only corrupts the heap on
 * Windows.
 */
export function modelFreeIsUnsafe(platform: NodeJS.Platform, systemInfo: string): boolean {
  return platform === "win32" && /\bAMX_INT8 = 1\b/.test(systemInfo);
}

/** The load options a model was loaded with, keyed so equal options match. */
const loadKeys = new WeakMap<LlamaModel, string>();
/** Models released on a host that cannot free them, by load key. */
const kept = new Map<string, LlamaModel[]>();
let unfreeable = false;
let explained = false;

/** JSON leaves out function-valued options, such as a progress callback, which do not change the model. */
function loadKey(options: LlamaModelOptions): string {
  return JSON.stringify(options);
}

/** Load a model, or take back one released earlier with the same options. */
export async function loadLlamaModel(options: LlamaModelOptions): Promise<LlamaModel> {
  const key = loadKey(options);
  const reused = kept.get(key)?.pop();
  if (reused) {
    if (kept.get(key)?.length === 0) kept.delete(key);
    return reused;
  }
  const llama = await getLlamaInstance();
  const model = await llama.loadModel(options);
  loadKeys.set(model, key);
  if (modelFreeIsUnsafe(process.platform, llama.systemInfo)) unfreeable = true;
  return model;
}

/** Free a model loaded with {@link loadLlamaModel}, or keep it where freeing would crash. */
export async function releaseLlamaModel(model: LlamaModel): Promise<void> {
  if (!unfreeable) {
    await model.dispose();
    return;
  }
  const key = loadKeys.get(model);
  if (key !== undefined) {
    const models = kept.get(key) ?? [];
    if (!models.includes(model)) models.push(model);
    kept.set(key, models);
  }
  if (!explained) {
    explained = true;
    log.warn(
      "Keeping local models loaded until the gateway restarts: llama.cpp cannot free a " +
        "model on Windows with an AMX CPU without crashing the process. A model loaded " +
        "again reuses the kept copy.",
    );
  }
}

/**
 * Whether this thread loaded a model that must never be freed, so the thread
 * must stay alive until the process ends.
 */
export function holdsUnfreeableLlamaModels(): boolean {
  return unfreeable;
}
