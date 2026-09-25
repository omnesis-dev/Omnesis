// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ProcessVitalsResult } from "@omnesis/core/doctor";

/**
 * The doctor needs only the current event-loop and memory readings. Keeping
 * this sampler collector-local avoids pulling the gateway's history, CPU/GC
 * journal, and stall-log responsibilities into a second daemon.
 */
export class CollectorDoctorVitals {
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentEventLoop: ProcessVitalsResult["eventLoop"] extends
    | { current: infer T }
    | undefined
    ? T
    : never = null;

  constructor() {
    this.eventLoop.enable();
  }

  start(): void {
    if (this.interval) return;
    this.sample();
    this.interval = setInterval(() => this.sample(), 1_000);
    this.interval.unref();
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.eventLoop.disable();
  }

  snapshot(): ProcessVitalsResult {
    const memory = process.memoryUsage();
    return {
      eventLoop: { current: this.currentEventLoop },
      memory: {
        current: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
        },
      },
    };
  }

  private sample(): void {
    this.currentEventLoop = {
      p50Ms: this.eventLoop.percentile(50) / 1e6,
      p95Ms: this.eventLoop.percentile(95) / 1e6,
      p99Ms: this.eventLoop.percentile(99) / 1e6,
    };
    this.eventLoop.reset();
  }
}
