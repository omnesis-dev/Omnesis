// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_PUSH_WAKE_RETRY_SETTINGS } from "@omnesis/config";
import { StatelessTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { PushBroadcaster } from "../../push/broadcast.js";
import type { Scheduler } from "../scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

interface RetryResult {
  idle: boolean;
}

export interface PushWakeRetryBundle {
  task: PeriodicTask<unknown, RetryResult>;
  job: BackgroundJob;
}

/** Build the thin scheduler adapter around the broadcaster's durable queue drain. */
export function createPushWakeRetryTask(
  broadcaster: Pick<PushBroadcaster, "retryDueWakes">,
  scheduler: Scheduler,
  log: Logger,
  cadence: { intervalMs: number; idleIntervalMs: number } = {
    intervalMs: DEFAULT_PUSH_WAKE_RETRY_SETTINGS.intervalMs,
    idleIntervalMs: DEFAULT_PUSH_WAKE_RETRY_SETTINGS.idleIntervalMs,
  },
): PushWakeRetryBundle {
  const task: PeriodicTask<unknown, RetryResult> = {
    name: "notifications.retryWakes.tick",
    runner: "main",
    priority: "background",
    periodMs: cadence.intervalMs,
    idlePeriodMs: cadence.idleIntervalMs,
    startDelayMs: 0,
    initialArgs: undefined,
    isIdle: (result) => result.idle,
    async run(): Promise<TaskOutcome<unknown, RetryResult>> {
      try {
        const result = await broadcaster.retryDueWakes();
        if (result.attempted > 0) {
          log.info(
            `notification wake retry attempted ${result.attempted}: ${result.succeeded} succeeded`,
          );
        }
        return { kind: "done", value: { idle: result.attempted === 0 } };
      } catch (error) {
        log.warn(
          `notification wake retry failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { kind: "done", value: { idle: true } };
      }
    },
  };
  return {
    task,
    job: periodicJob(task, {
      scheduler,
      displayName: "Notification wake retry",
      description: "Retries leased content-free mobile wake signals after transient failures.",
      category: "infra",
      tracker: new StatelessTracker(),
    }),
  };
}
