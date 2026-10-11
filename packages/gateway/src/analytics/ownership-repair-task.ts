// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ownership repair — where a shared analytics table's legacy rows get the
 * account that provably wrote them.
 *
 * A sync page labels such rows as it is admitted, but only one bounded batch
 * per page, and a quiet source sends no pages at all: a history nobody revisits
 * would otherwise stay half-attributed for as long as the source stays quiet.
 * This task runs the same bounded batch per pending table on its own clock, at
 * background priority under admission control. A tick that labelled rows keeps
 * the active cadence, so a backlog drains over ticks; a tick that labelled none
 * — nothing pending, or only rows no proof reaches — backs off to the idle
 * period. An idle tick still scans each pending table for rows it could label,
 * work proportional to the table, which is why the idle period is long.
 */

import { type Logger } from "@omnesis/core";
import { ScanTracker } from "../background-jobs/trackers.js";
import { periodicJob } from "../background-jobs/scheduler-job.js";
import { runWithPriority } from "../priority.js";
import type { BackgroundJob } from "../background-jobs/types.js";
import type { OwnershipRepairTick } from "./table-manager.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";

interface IdleResult {
  idle: boolean;
}

/** How often the repair runs another batch while the last one labelled rows. */
const DEFAULT_ACTIVE_PERIOD_MS = 5_000;

/**
 * How often it looks again once nothing was left to label. The only event that
 * makes a stuck table attributable is a parent page landing, and that page's
 * admission already repairs one batch, so the child losing ten minutes is cheap
 * next to rescanning every stuck table more often.
 */
const DEFAULT_IDLE_PERIOD_MS = 10 * 60_000;

/** Keeps boot quiet while collectors reconnect and register their tables. */
const DEFAULT_START_DELAY_MS = 15_000;

export interface OwnershipRepairTaskOptions {
  analyticsDb: { repairPendingOwnership(): Promise<OwnershipRepairTick> };
  log: Logger;
  activePeriodMs?: number;
  idlePeriodMs?: number;
  startDelayMs?: number;
}

export interface OwnershipRepairBundle {
  task: PeriodicTask<undefined, IdleResult>;
  job: BackgroundJob;
}

export function createOwnershipRepairTask(
  opts: OwnershipRepairTaskOptions,
  scheduler: Scheduler,
): OwnershipRepairBundle {
  const tracker = new ScanTracker();
  // Rows labelled since the repair last went idle, reported once per drain
  // rather than once per batch.
  let drained = 0;

  const task: PeriodicTask<undefined, IdleResult> = {
    name: "analytics.ownershipRepair",
    runner: "main",
    priority: "background",
    periodMs: opts.activePeriodMs ?? DEFAULT_ACTIVE_PERIOD_MS,
    idlePeriodMs: opts.idlePeriodMs ?? DEFAULT_IDLE_PERIOD_MS,
    startDelayMs: opts.startDelayMs ?? DEFAULT_START_DELAY_MS,
    latencyBudgetMs: 1_000,
    initialArgs: undefined,
    async run(): Promise<TaskOutcome<undefined, IdleResult>> {
      // A kick from a request path would carry that request's priority into
      // every writer call below; the repair is background work regardless.
      return runWithPriority("background", async () => {
        tracker.recordSweepStarted();
        let tick: OwnershipRepairTick;
        try {
          tick = await opts.analyticsDb.repairPendingOwnership();
        } catch (err) {
          opts.log.warn(
            `ownership repair failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Failure proves nothing about the backlog; retry on the active cadence.
          return { kind: "done", value: { idle: false } };
        }
        tracker.recordSweepCompleted({ checked: tick.tables, affected: tick.attributed });
        drained += tick.attributed;
        if (tick.attributed > 0) return { kind: "done", value: { idle: false } };
        if (drained > 0) {
          opts.log.info(
            `ownership repair labelled ${drained} legacy analytics row${drained === 1 ? "" : "s"} with their account`,
          );
          drained = 0;
        }
        return { kind: "done", value: { idle: true } };
      });
    },
    isIdle: (result) => result.idle,
  };

  return {
    task,
    job: periodicJob(task, {
      scheduler,
      displayName: "Analytics ownership repair",
      description:
        "Labels legacy rows of shared analytics tables with the account that provably wrote them, one bounded batch per table per tick.",
      category: "infra",
      tracker,
    }),
  };
}
