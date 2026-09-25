// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { StatelessTracker } from "../../background-jobs/trackers.js";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type {
  SubscriptionDeliveryDrainResult,
  SubscriptionDeliveryService,
} from "../../subscriptions/delivery.js";
import type { Scheduler } from "../scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

interface DrainResult {
  idle: boolean;
  delivery: SubscriptionDeliveryDrainResult;
}

export interface SubscriptionDeliveriesTaskOpts {
  service: SubscriptionDeliveryService;
  intervalMs?: number;
  idleMs?: number;
  startDelayMs?: number;
  onError?: (error: unknown) => void;
}

export interface SubscriptionDeliveriesTaskBundle {
  tasks: PeriodicTask<unknown, DrainResult>[];
  jobs: BackgroundJob[];
}

export function createSubscriptionDeliveriesTask(
  opts: SubscriptionDeliveriesTaskOpts,
  scheduler: Scheduler,
): SubscriptionDeliveriesTaskBundle {
  const task: PeriodicTask<unknown, DrainResult> = {
    name: "subscriptions.deliveryDrain",
    runner: "main",
    priority: "background",
    periodMs: opts.intervalMs ?? 3_000,
    idlePeriodMs: opts.idleMs ?? 30_000,
    startDelayMs: opts.startDelayMs ?? 8_000,
    latencyBudgetMs: 60_000,
    initialArgs: undefined,
    isIdle: (result) => result.idle,
    async run(): Promise<TaskOutcome<unknown, DrainResult>> {
      try {
        const delivery = await opts.service.drainOnce();
        return {
          kind: "done",
          value: { idle: delivery.claimed === 0, delivery },
        };
      } catch (error) {
        opts.onError?.(error);
        return {
          kind: "done",
          value: {
            idle: false,
            delivery: { claimed: 0, delivered: 0, retrying: 0, failed: 0, stale: 0 },
          },
        };
      }
    },
  };

  return {
    tasks: [task],
    jobs: [
      periodicJob(task, {
        scheduler,
        displayName: "Subscription delivery",
        description:
          "Delivers approved identifier-only subscription wakes to connected agent integrations with durable retry.",
        category: "watches",
        tracker: new StatelessTracker(),
      }),
    ],
  };
}
