// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OS-level deprioritization for the background compute workers (cpu-worker,
 * io-worker). The scheduler already isolates background work into its own
 * runners, but those worker threads run at the *same OS priority* as the main
 * event loop (which serves real-time search + Briefs/Loops/Calendar reads) and
 * the embedder thread — so under core contention the kernel gives
 * background shingle/DF/link compute an equal share and starves interactive
 * reads. Renicing these threads DOWN lets the kernel prefer real-time work
 * whenever cores are contended, with zero effect when they aren't.
 *
 * This deliberately does NOT touch the writer worker (its work is often on the
 * user's critical path via agent writes) or the indexer/embed worker (real-time
 * query-embed runs there).
 *
 * See omnesis-dev/Omnesis#199 (Lever 3).
 */

import os from "node:os";

/**
 * Default nice for background compute workers. `10` is moderately
 * deprioritized (nice runs -20..19); it yields CPU to the default-priority
 * (nice 0) main loop / writer / embedder under contention without starving
 * the background work outright.
 */
export const DEFAULT_BACKGROUND_WORKER_NICE = 10;

/** Clamp an arbitrary number to the valid nice range and drop the fraction. */
function clampNice(n: number): number {
  return Math.max(-20, Math.min(19, Math.trunc(n)));
}

/**
 * Resolve the target nice value with the standard tunable precedence used
 * across `runtime-settings.ts`: the `OMNESIS_BACKGROUND_WORKER_NICE` env
 * override wins, then the resolved config value (`gateway.backgroundWorkerNice`),
 * then the default — clamped to the valid nice range. A present-but-malformed
 * env value (non-numeric) is ignored and resolution falls through to config,
 * so a garbage override never silently discards a deliberately-set config value.
 * Runs on the MAIN thread; the resolved number is threaded into each worker via
 * its init message so the worker never reaches around config to read the
 * environment itself.
 */
export function resolveBackgroundWorkerNice(
  configValue?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawEnv = env.OMNESIS_BACKGROUND_WORKER_NICE;
  if (rawEnv !== undefined && rawEnv !== "") {
    const n = Number(rawEnv);
    if (Number.isFinite(n)) return clampNice(n);
  }
  if (configValue !== undefined && Number.isFinite(configValue)) return clampNice(configValue);
  return DEFAULT_BACKGROUND_WORKER_NICE;
}

/**
 * Renice the CALLING worker thread to the given (already-resolved) nice value.
 *
 * Linux-only. On Linux nice is a per-thread attribute and
 * `setpriority(PRIO_PROCESS, 0, …)` (what `os.setPriority(0, …)` compiles to)
 * targets the calling task, so this lands on the worker thread, not the whole
 * process (verify with `top -H`). On macOS/BSD the same call is per-*process*
 * and would renice the entire gateway — main event loop included — which is the
 * opposite of the intent, so we no-op off Linux.
 *
 * Lowering one's own priority never requires privilege. Best-effort otherwise:
 * any failure (unexpected errno) is reported to `onError` and ignored —
 * functional correctness never depends on it. Returns the applied nice, or null
 * if it was skipped/failed.
 */
export function deprioritizeBackgroundWorker(
  nice: number,
  workerName: string,
  onError?: (message: string) => void,
): number | null {
  if (process.platform !== "linux") return null;
  try {
    os.setPriority(0, nice);
    return nice;
  } catch (err) {
    onError?.(
      `could not renice ${workerName} worker to nice ${nice}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
