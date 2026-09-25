// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ground truth for the deterministic derivation pipeline's backlog, and the
 * alarm when it runs later than the readiness barrier allows.
 *
 * The per-stage drips (link extraction, people resolution, date extraction)
 * each report throughput, which answers "is the loop running" but not "how far
 * behind is it". Those are different questions: a drip processing five
 * documents a second looks healthy right up until the head of its queue is a
 * day old. The cognition readiness barrier is written against the second
 * quantity — it holds a `data` run until its datum is derived, then gives up
 * after a bounded wait — so the operator needs the same quantity to see why a
 * run went ahead with an incomplete picture.
 *
 * One task and one job per registered derivation stage, so the portal names
 * the stage that is late instead of an aggregate the operator has to
 * decompose by hand. Each scan runs on the read handle over that stage's
 * partial index, so it never parks the writer.
 */

import { QueueTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import {
  DERIVATION_STAGES,
  oldestPendingDerivationMs,
  type DerivationStage,
} from "../../domain/DocumentDerivation.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

type Db = Database.Database;

interface IdleResult {
  idle: boolean;
}

/** Default scan cadence. The quantity moves slowly and the scan is not free. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_START_DELAY_MS = 30_000;

export interface DerivationSlaOpts {
  db: Db;
  log: Logger;
  /**
   * The readiness barrier, re-read per scan — the SLA these tasks report
   * against. A stage whose oldest undrained document is older than this has
   * already caused at least one run to be claimed on partial context.
   */
  getBarrierMs: () => number;
  /**
   * Whether the cognition engine that enforces the barrier is actually
   * running. The backlog itself is worth watching on every install, but the
   * consequence a breach carries — agent runs proceeding on partial graph
   * context — only exists when there are agent runs, so the warning is held
   * back while the engine is inactive.
   */
  isBarrierActive: () => boolean;
  clock?: () => number;
  intervalMs?: number;
  startDelayMs?: number;
}

export interface DerivationSlaBundle {
  tasks: PeriodicTask<unknown, IdleResult>[];
  jobs: BackgroundJob[];
}

function stageTask(
  stage: DerivationStage,
  opts: DerivationSlaOpts,
): { task: PeriodicTask<unknown, IdleResult>; tracker: QueueTracker } {
  const { db, log } = opts;
  const clock = opts.clock ?? (() => Date.now());
  const tracker = new QueueTracker();
  const countSql = `SELECT COUNT(*) AS n FROM documents WHERE ${stage.column} IS NULL`;
  /** Latched so a persistent breach logs on transition, not once per scan. */
  let breaching = false;

  const task: PeriodicTask<unknown, IdleResult> = {
    name: `backfill.derivationSla.${stage.id}`,
    runner: "main",
    priority: "background",
    periodMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    startDelayMs: opts.startDelayMs ?? DEFAULT_START_DELAY_MS,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const now = clock();
      const barrierMs = opts.getBarrierMs();
      const remaining = db.prepare<[], { n: number }>(countSql).get()!.n;
      const oldest = oldestPendingDerivationMs(db, stage, now);
      const enforced = opts.isBarrierActive() && barrierMs > 0;
      tracker.setRemaining(remaining, now);
      tracker.setOldestPendingMs(oldest, enforced ? barrierMs : undefined);

      const breached = enforced && oldest !== null && oldest > barrierMs;
      if (breached && !breaching) {
        breaching = true;
        log.warn(
          `derivation SLA breached: ${stage.label} has ${remaining} document(s) outstanding, oldest waiting ${Math.round(oldest / 60_000)}m against a ${Math.round(barrierMs / 60_000)}m barrier — data runs on those documents are being claimed on partial graph context`,
        );
      } else if (!breached && breaching) {
        breaching = false;
        log.info(`derivation SLA recovered: ${stage.label} is within the barrier again`);
      }
      return { kind: "done", value: { idle: remaining === 0 } };
    },
  };
  return { task, tracker };
}

/** Build the per-stage backlog observers from the derivation registry. */
export function derivationSlaTasks(
  opts: DerivationSlaOpts,
  scheduler: Scheduler,
): DerivationSlaBundle {
  const tasks: PeriodicTask<unknown, IdleResult>[] = [];
  const jobs: BackgroundJob[] = [];
  for (const stage of DERIVATION_STAGES) {
    const { task, tracker } = stageTask(stage, opts);
    tasks.push(task);
    jobs.push(
      periodicJob(task, {
        scheduler,
        displayName: `Derivation backlog — ${stage.label}`,
        description: `Documents still awaiting ${stage.label}, and how long the oldest has waited at the head of the queue.`,
        category: "graph",
        tracker,
      }),
    );
  }
  return { tasks, jobs };
}
