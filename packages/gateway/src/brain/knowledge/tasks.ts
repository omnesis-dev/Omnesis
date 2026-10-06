// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { StatelessTracker } from "../../background-jobs/trackers.js";
import { runWithPriority } from "../../priority.js";
import { cadenceEnvInt } from "../cadence-env.js";
import type { KnowledgeEngine } from "./engine.js";
import type { KnowledgeWriteGate } from "./writer.js";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { PeriodicTask } from "../../scheduler/types.js";

/** Privacy cleanup remains live even when autonomous cognition is disabled. */
export function knowledgeCascadeTask(deps: {
  writeGate: KnowledgeWriteGate;
  scheduler: Scheduler;
  clock: () => number;
  removeMirrors?: (ids: string[]) => Promise<void>;
  drainMirrors?: () => Promise<boolean>;
}) {
  const task: PeriodicTask<undefined, { pending: boolean }> = {
    name: "knowledge.cascade",
    runner: "main",
    priority: "background",
    periodMs: 1000,
    idlePeriodMs: 15000,
    startDelayMs: 500,
    latencyBudgetMs: 1000,
    initialArgs: undefined,
    isIdle: (result) => !result.pending,
    async run() {
      const result = await runWithPriority("background", () =>
        deps.writeGate["knowledge.advanceCascade"](100, deps.clock()),
      );
      if (result.deletedNodeIds.length) await deps.removeMirrors?.(result.deletedNodeIds);
      const pendingMirrors = await deps.drainMirrors?.();
      return { kind: "done", value: { pending: result.pending || !!pendingMirrors } };
    },
  };
  const job = periodicJob(task, {
    scheduler: deps.scheduler,
    displayName: "Knowledge evidence cascades",
    description: "Completes durable invalidation and privacy cleanup in bounded writer slices.",
    category: "briefs",
    tracker: new StatelessTracker(),
  });
  return { task, job };
}
export function knowledgeMaintenanceTask(deps: {
  engine: KnowledgeEngine;
  scheduler: Scheduler;
  isEnabled: () => boolean;
  intervalMs?: number;
  idleMs?: number;
  startDelayMs?: number;
}) {
  const task: PeriodicTask<undefined, { idle: boolean }> = {
    name: "knowledge.maintenance",
    runner: "main",
    priority: "background",
    periodMs: deps.intervalMs ?? cadenceEnvInt("OMNESIS_COGNITION_WAKER_INTERVAL_MS") ?? 1000,
    idlePeriodMs:
      deps.idleMs ?? deps.intervalMs ?? cadenceEnvInt("OMNESIS_COGNITION_WAKER_IDLE_MS") ?? 15000,
    startDelayMs:
      deps.startDelayMs ??
      deps.intervalMs ??
      cadenceEnvInt("OMNESIS_COGNITION_WAKER_START_DELAY_MS") ??
      1000,
    latencyBudgetMs: 60000,
    initialArgs: undefined,
    isIdle: (result) => result.idle,
    async run() {
      if (!deps.isEnabled()) return { kind: "done", value: { idle: true } };
      const result = await runWithPriority("background", () => deps.engine.tick());
      return { kind: "done", value: { idle: !result.cascading && !result.enqueued } };
    },
  };
  const job = periodicJob(task, {
    scheduler: deps.scheduler,
    displayName: "Knowledge maintenance",
    description:
      "Batches evidence changes, discovery and reviews into versioned synthesis frontiers.",
    category: "briefs",
    tracker: new StatelessTracker(),
    isDisabled: () => !deps.isEnabled(),
  });
  return { task, job };
}
