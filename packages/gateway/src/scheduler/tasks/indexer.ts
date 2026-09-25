// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Indexer wake task — replaces the bespoke debounce timer in
 * `workers/indexer-worker.ts` with the Scheduler's uniform `wake`
 * primitive.
 *
 * Design:
 *   - The Scheduler's `WakeableTask` debounces wakes by `debounceMs`
 *     on the **main** thread. Multiple `scheduler.wake("indexer.update")`
 *     calls within the window collapse to one outgoing message.
 *   - This task's `run()` posts a "wake" to the indexer worker via
 *     `pingWorker()` and resolves immediately. The worker side still
 *     owns the cycle (it has the embedder + index DB handle) and keeps
 *     its own `inFlightCycle` + `pendingWake` guards as a belt-and-
 *     suspenders against overlapping cycles.
 *   - We deliberately set `coalesceTrailingWake: false` because run()
 *     is fire-and-forget — the wakeable is in flight only while we
 *     post the message (microseconds). Trailing-wake coalescing happens
 *     inside the worker via its `pendingWake` flag.
 *
 * Net effect: today's worker-side debounce moves to main; cycle
 * concurrency control stays in the worker. Any code path that wants
 * the indexer to run NOW just calls `scheduler.wake("indexer.update")`.
 */

import { StatelessTracker } from "../../background-jobs/trackers.js";
import { wakeableJob } from "../../background-jobs/scheduler-job.js";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../scheduler.js";
import type { TaskOutcome, WakeableTask } from "../types.js";

export interface IndexerWakeTaskOpts {
  /**
   * Send a wake signal to the indexer worker. Typically:
   * `() => indexerWorkerProxy.wake()` (which posts {type:"wake"} on
   * the worker_thread channel). Fire-and-forget.
   */
  pingWorker: () => void;
  log: Logger;
  /** Debounce window. Default 250ms — matches legacy WAKE_DEBOUNCE_MS. */
  debounceMs?: number;
}

export interface IndexerWakeBundle {
  task: WakeableTask<unknown, void>;
  job: BackgroundJob;
}

export function indexerWakeTask(
  opts: IndexerWakeTaskOpts,
  scheduler: Scheduler,
): IndexerWakeBundle {
  const tracker = new StatelessTracker();
  const task: WakeableTask<unknown, void> = {
    name: "indexer.wake",
    runner: "main",
    priority: "background",
    debounceMs: opts.debounceMs ?? 250,
    /**
     * Worker-side `pendingWake` already provides "if a wake arrives
     * mid-cycle, fire one more after". We don't need the Scheduler's
     * trailing coalesce on top — it'd just enqueue a redundant message.
     */
    coalesceTrailingWake: false,
    initialArgs: undefined,
    async run(): Promise<TaskOutcome<unknown, void>> {
      try {
        opts.pingWorker();
      } catch (err) {
        opts.log.warn(`indexer wake failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { kind: "done", value: undefined };
    },
  };
  const job = wakeableJob(task, {
    scheduler,
    displayName: "Indexer wake debouncer",
    description:
      "Coalesces wake signals from POST /documents and forwards them to the indexer worker.",
    category: "indexer",
    tracker,
  });
  return { task, job };
}
