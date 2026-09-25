// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-wide activity-retention drip.
 *
 * One tick performs one bounded unit: one short writer transaction, one small
 * transcript unlink batch, or one small conversation cleanup batch. Returning
 * to the Scheduler between units is what keeps retention from parking the
 * single SQLite writer behind a large sweep.
 */

import { parseDuration, type Logger } from "@omnesis/core";
import { ScanTracker } from "../background-jobs/trackers.js";
import { periodicJob } from "../background-jobs/scheduler-job.js";
import { runWithPriority } from "../priority.js";
import { ACTIVITY_RETENTION_PHASES, type ActivityRetentionPhase } from "./store.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { BackgroundJob } from "../background-jobs/types.js";
import type { FsCognitionTranscriptStore } from "../brain/transcripts.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";
import type { WriteGate } from "../write-gate.js";

interface IdleResult {
  idle: boolean;
}

type SweepPhase =
  | ActivityRetentionPhase
  | "cognitionTranscripts"
  | "agentConversations"
  | "sqlitePages";

const SWEEP_PHASES: readonly SweepPhase[] = [
  ...ACTIVITY_RETENTION_PHASES,
  "cognitionTranscripts",
  "agentConversations",
  "sqlitePages",
];

export interface ActivityRetentionTaskOptions {
  writeGate: WriteGate;
  transcripts: FsCognitionTranscriptStore;
  pruneConversations: (
    cutoffMs: number,
    limit: number,
  ) => Promise<{ deleted: number; hasMore: boolean }>;
  getConfig: () => OmnesisConfig;
  log: Logger;
  clock?: () => number;
  dbBatchSize?: number;
  transcriptBatchSize?: number;
  conversationBatchSize?: number;
  activePeriodMs?: number;
  idlePeriodMs?: number;
  startDelayMs?: number;
}

export interface ActivityRetentionBundle {
  task: PeriodicTask<undefined, IdleResult>;
  job: BackgroundJob;
}

export function createActivityRetentionTask(
  opts: ActivityRetentionTaskOptions,
  scheduler: Scheduler,
): ActivityRetentionBundle {
  const clock = opts.clock ?? Date.now;
  const tracker = new ScanTracker();
  let phaseIndex = 0;
  let affectedThisSweep = 0;
  let checkedThisSweep = 0;

  const task: PeriodicTask<undefined, IdleResult> = {
    name: "activityRetention.sweep",
    runner: "main",
    priority: "background",
    periodMs: opts.activePeriodMs ?? 1_000,
    idlePeriodMs: opts.idlePeriodMs ?? 6 * 60 * 60_000,
    startDelayMs: opts.startDelayMs ?? 5 * 60_000,
    latencyBudgetMs: 1_000,
    initialArgs: undefined,
    isIdle: (result) => result.idle,
    async run(): Promise<TaskOutcome<undefined, IdleResult>> {
      // A config edit can kick this periodic while its HTTP request still
      // carries user-priority AsyncLocalStorage. Override that inherited
      // context for the whole unit so every nested writer call remains
      // background work (the #199 priority-inversion rule).
      return runWithPriority("background", async () => {
        const config = opts.getConfig();
        const globalRetentionMs = optionalDuration(config.activityRetention?.maxAge);
        const cognitionRetentionMs =
          optionalDuration(config.brain?.transcriptRetention) ?? globalRetentionMs;
        if (globalRetentionMs === null && cognitionRetentionMs === null) {
          phaseIndex = 0;
          affectedThisSweep = 0;
          checkedThisSweep = 0;
          return { kind: "done", value: { idle: true } };
        }

        if (phaseIndex === 0) tracker.recordSweepStarted();
        const phase = SWEEP_PHASES[phaseIndex]!;
        const retentionMs =
          phase === "cognitionTranscripts" ? cognitionRetentionMs : globalRetentionMs;
        let deleted = 0;
        let hasMore = false;

        try {
          if (retentionMs !== null) {
            const cutoff = clock() - retentionMs;
            if (phase === "cognitionTranscripts") {
              const limit = opts.transcriptBatchSize ?? 100;
              const result = await opts.transcripts.pruneBatch(cutoff, limit);
              deleted = result.deleted;
              hasMore = result.hasMore;
            } else if (phase === "agentConversations") {
              // The delete cascade also removes the conversation's corpus and
              // index rows. One conversation per tick bounds that cascade and
              // the filesystem work before yielding.
              const limit = opts.conversationBatchSize ?? 1;
              const result = await opts.pruneConversations(cutoff, limit);
              deleted = result.deleted;
              hasMore = result.hasMore;
            } else if (phase === "sqlitePages") {
              deleted = await opts.writeGate.reclaimActivityRetentionPages(64);
              hasMore = deleted === 64;
            } else {
              const result = await opts.writeGate.pruneActivityRetentionBatch(
                phase,
                cutoff,
                opts.dbBatchSize ?? 100,
              );
              deleted = result.deleted;
              hasMore = result.hasMore;
            }
          }
        } catch (err) {
          opts.log.warn(
            `activity retention ${phase} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Move on after a failed phase. A later sweep retries it; repeatedly
          // hammering one malformed store would starve the other phases.
          hasMore = false;
        }

        checkedThisSweep += 1;
        affectedThisSweep += deleted;
        if (!hasMore) phaseIndex += 1;
        if (phaseIndex < SWEEP_PHASES.length) {
          return { kind: "done", value: { idle: false } };
        }

        tracker.recordSweepCompleted({
          checked: checkedThisSweep,
          affected: affectedThisSweep,
        });
        if (affectedThisSweep > 0) {
          opts.log.info(
            `activity retention reclaimed ${affectedThisSweep} expired rows, files, or free pages`,
          );
        }
        const idle = affectedThisSweep === 0;
        phaseIndex = 0;
        affectedThisSweep = 0;
        checkedThisSweep = 0;
        return { kind: "done", value: { idle } };
      });
    },
  };

  return {
    task,
    job: periodicJob(task, {
      scheduler,
      displayName: "Activity retention",
      description:
        "Reclaims expired operational history and unpinned transcripts in bounded background batches.",
      category: "infra",
      tracker,
      isDisabled: () =>
        opts.getConfig().activityRetention?.maxAge === undefined &&
        opts.getConfig().brain?.transcriptRetention === undefined,
    }),
  };
}

function optionalDuration(raw: string | undefined): number | null {
  return raw === undefined ? null : parseDuration(raw);
}
