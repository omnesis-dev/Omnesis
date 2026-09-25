// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Periodic re-probe of inference backends that were unreachable at gateway boot
 * (or during a transient network blip). Without it, a backend that the one-shot
 * boot probe found unreachable stays `available:false` until a config change or
 * a manual `POST /admin/inference/backends/:key/probe` — so e.g. a cloud
 * provider briefly unreachable during startup would leave the background agent
 * dark indefinitely (#1267).
 *
 * The recovery schedule (per-backend exponential backoff) lives in
 * `InferenceRegistry.reprobeUnavailable`; this task just drives it on a cadence
 * and idles when every backend is healthy and agent reconciliation succeeds.
 */

import { StatelessTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../scheduler.js";
import type { InferenceRegistry } from "../../inference/registry.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

interface ReprobeResult {
  idle: boolean;
}

export interface BackendReprobeOpts {
  registry: InferenceRegistry;
  log: Logger;
  /** Clock, injected for testability. Default `Date.now`. */
  now?: () => number;
  /** Cadence while at least one backend is unreachable. Default 30s. */
  intervalMs?: number;
  /** Cadence when every backend is healthy. Default 5min. */
  idleMs?: number;
  /** Delay before the first tick. Default 30s. */
  startDelayMs?: number;
  /** Reconcile any boot-disabled HTTP agent after registry state changes. */
  reconcileAgent?: () => Promise<void>;
}

export interface BackendReprobeBundle {
  tasks: PeriodicTask<unknown, ReprobeResult>[];
  jobs: BackgroundJob[];
}

/**
 * Build the backend re-probe PeriodicTask. Caller schedules the task via
 * `scheduler.schedule(t)` and registers the job via `registry.registerAll(jobs)`.
 */
export function createBackendReprobeTask(
  opts: BackendReprobeOpts,
  scheduler: Scheduler,
): BackendReprobeBundle {
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? 30_000;
  const idle = opts.idleMs ?? 5 * 60_000;
  const startDelay = opts.startDelayMs ?? 30_000;

  const task: PeriodicTask<unknown, ReprobeResult> = {
    name: "inference.reprobeUnavailable.tick",
    runner: "main",
    priority: "background",
    periodMs: interval,
    idlePeriodMs: idle,
    startDelayMs: startDelay,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, ReprobeResult>> {
      let down: number;
      let recovered: number;
      try {
        ({ down, recovered } = await opts.registry.reprobeUnavailable(now()));
      } catch (err) {
        opts.log.warn(
          `backend re-probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: true } };
      }
      if (recovered > 0) {
        opts.log.info(
          `re-probe recovered ${recovered} backend${recovered === 1 ? "" : "s"}; ${
            down - recovered
          } still down`,
        );
      }
      // Reconcile on every tick, not only the recovery edge. Besides healing
      // boot-time failures, this retries a rare failed lifecycle rebuild and
      // notices recovery performed by the manual probe endpoint.
      let reconciliationFailed = false;
      try {
        await opts.reconcileAgent?.();
      } catch (err) {
        reconciliationFailed = true;
        opts.log.warn(
          `agent recovery reconciliation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Stay on the active cadence while anything is down (so per-backend
      // backoff windows are re-evaluated); idle only when all are now healthy
      // and reconciliation did not need a prompt retry.
      return { kind: "done", value: { idle: down === recovered && !reconciliationFailed } };
    },
  };

  return {
    tasks: [task],
    jobs: [
      periodicJob(task, {
        scheduler,
        displayName: "Inference backend re-probe",
        description:
          "Re-probes inference backends that were unreachable at boot so they recover without a restart (#1267).",
        category: "infra",
        tracker: new StatelessTracker(),
      }),
    ],
  };
}
