// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import { createLogger, isCompiledModule, resolveWorkerEntry } from "@omnesis/core";

const log = createLogger("gateway:startup:modules");

/** How long startup waits for the prewarm before it loads the runtime without it. */
export const DEFAULT_MODULE_PREWARM_WAIT_MS = 30_000;

export type ModulePrewarmOutcome =
  | { state: "loaded" }
  | { state: "skipped" }
  | { state: "stopped" }
  | { state: "timed out" }
  | { state: "failed"; reason: string };

export interface ModulePrewarm {
  /**
   * Waits up to `waitMs` for the prewarm to finish, stopping it if it has not.
   * Never rejects: whatever the outcome, the caller then imports normally.
   */
  finish(waitMs: number): Promise<ModulePrewarmOutcome>;
}

/**
 * Warms the TypeScript transform cache for `root`'s module graph.
 *
 * Importing the gateway runtime is synchronous on the calling thread: Node
 * resolves, reads, transforms, compiles, links and evaluates its whole graph
 * before the thread can do anything else, including answer the startup
 * listener. In source mode, on a cold transform cache, the transforms are most
 * of that time. A worker thread loads the same graph first without evaluating
 * it, so the main thread's import then reads every transform from the cache.
 * Compiled installs transform nothing, so there they start nothing.
 */
export function startModulePrewarm(root: string, signal: AbortSignal): ModulePrewarm {
  if (isCompiledModule(import.meta.url)) return settled({ state: "skipped" });
  if (signal.aborted) return settled({ state: "stopped" });
  let worker: Worker;
  try {
    const entry = resolveWorkerEntry(
      "../workers/module-prewarm-worker.ts",
      import.meta.url,
      "../workers/register-tsx.mjs",
    );
    // The worker loads modules through this thread's own loader options, so
    // it resolves and transforms them exactly as the import it warms will.
    const loaderOptions = moduleLoaderOptions(process.execArgv);
    worker = new Worker(entry.url, {
      execArgv: loaderOptions.length > 0 ? loaderOptions : entry.execArgv,
      workerData: { prewarmRoot: root },
    });
  } catch (error) {
    return settled({
      state: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  let failure: string | undefined;
  let loaded = false;
  worker.on("message", (message: { type?: unknown; message?: unknown }) => {
    if (message.type === "loaded") loaded = true;
    else failure ??= typeof message.message === "string" ? message.message : "invalid message";
  });
  worker.on("error", (error) => {
    failure ??= error.message;
  });
  const stop = (): void => void worker.terminate().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  const exited = new Promise<ModulePrewarmOutcome>((resolve) => {
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) resolve({ state: "stopped" });
      else if (loaded && failure === undefined && code === 0) resolve({ state: "loaded" });
      else resolve({ state: "failed", reason: failure ?? `the worker exited with code ${code}` });
    });
  });
  return {
    async finish(waitMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<ModulePrewarmOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ state: "timed out" }), waitMs);
      });
      const outcome = await Promise.race([exited, deadline]);
      clearTimeout(timer);
      if (outcome.state === "timed out") {
        stop();
        log.warn(
          `Module prewarm did not finish within ${waitMs}ms; loading the gateway without it`,
        );
      } else if (outcome.state === "failed") {
        log.warn(`Module prewarm failed (${outcome.reason}); loading the gateway without it`);
      }
      return outcome;
    },
  };
}

const LOADER_OPTIONS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
]);

/**
 * The Node options in `execArgv` that change how modules resolve and load.
 * The rest are left out: a worker refuses options that act on the whole
 * process, and an inherited `--input-type` or `--eval` is not about modules.
 */
export function moduleLoaderOptions(execArgv: readonly string[]): string[] {
  const options: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]!;
    const name = arg.split("=", 1)[0]!;
    if (!LOADER_OPTIONS.has(name)) continue;
    if (arg.includes("=")) options.push(arg);
    else if (index + 1 < execArgv.length) options.push(arg, execArgv[++index]!);
  }
  return options;
}

function settled(outcome: ModulePrewarmOutcome): ModulePrewarm {
  return { finish: () => Promise.resolve(outcome) };
}
