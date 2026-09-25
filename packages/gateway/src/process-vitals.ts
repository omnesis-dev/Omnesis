// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level vitals: event loop delay, CPU usage, memory, GC pauses.
 *
 * Samples four streams at 1 Hz into 600-element ring buffers (10 min).
 * `snapshot(windowSeconds)` returns the windowed view — same contract
 * as MetricsRegistry. Zero external dependencies; everything comes
 * from Node built-ins (`perf_hooks`, `process`).
 */

import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

import { createLogger } from "@omnesis/core";

import { Ring } from "./ring-buffer.js";

const RING_SIZE = 600; // 10 min @ 1 Hz

// ── Types ────────────────────────────────────────────────────────────

export interface EventLoopSample {
  ts: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface CpuUsageSample {
  ts: number;
  /** Fraction of one core spent in user-space JS (0..1+). */
  userPct: number;
  /** Fraction of one core spent in kernel syscalls (0..1+). */
  systemPct: number;
  /** userPct + systemPct. */
  totalPct: number;
}

export interface MemorySample {
  ts: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

export interface GcSample {
  ts: number;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface ProcessVitalsSnapshot {
  windowSeconds: number;
  generatedAt: string;
  eventLoop: {
    current: EventLoopSample | null;
    samples: EventLoopSample[];
  };
  cpu: {
    current: CpuUsageSample | null;
    samples: CpuUsageSample[];
    meanTotalPct: number;
    peakTotalPct: number;
  };
  memory: {
    current: MemorySample | null;
    samples: MemorySample[];
  };
  gc: {
    current: GcSample | null;
    samples: GcSample[];
    windowTotalMs: number;
    windowCount: number;
  };
}

// ── Collector ────────────────────────────────────────────────────────

const log = createLogger("gateway:vitals");

/**
 * A loop delay at or above this is worth a line in the journal. Well above
 * ordinary scheduling jitter, well below the multi-second stalls that make
 * a gateway look down.
 */
const LOOP_STALL_WARN_MS = 1_000;

/**
 * V8 reports the collection kind as a number; name it. Exported so the
 * mapping can be pinned directly — the numbers are V8's, not ours, and a
 * silent drift would turn every stall line's diagnosis into "unknown".
 */
export function gcKindName(entry: PerformanceEntry): string {
  const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
  switch (kind) {
    case 1:
      return "minor";
    case 2:
      return "major";
    case 4:
      return "incremental";
    case 8:
      return "weakcb";
    default:
      return "unknown";
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GiB`;
}

export class ProcessVitalsCollector {
  private elRing = new Ring<EventLoopSample>(RING_SIZE);
  private cpuRing = new Ring<CpuUsageSample>(RING_SIZE);
  private memRing = new Ring<MemorySample>(RING_SIZE);
  private gcRing = new Ring<GcSample>(RING_SIZE);

  private eld = monitorEventLoopDelay({ resolution: 20 });
  private prevCpu = process.cpuUsage();
  private prevCpuTs = Date.now();

  private gcAccum = { count: 0, totalMs: 0, maxMs: 0, maxKind: "" };
  private gcObserver: PerformanceObserver;

  private interval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.eld.enable();

    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcAccum.count += 1;
        this.gcAccum.totalMs += entry.duration;
        if (entry.duration > this.gcAccum.maxMs) {
          this.gcAccum.maxMs = entry.duration;
          // Which collection it was, not just how long it took: a major
          // collection on a large heap is a different diagnosis from a
          // string of minor ones.
          this.gcAccum.maxKind = gcKindName(entry);
        }
      }
    });
    this.gcObserver.observe({ entryTypes: ["gc"] });
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), 1_000);
    this.interval.unref();
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.eld.disable();
    this.gcObserver.disconnect();
  }

  private tick(): void {
    const now = Date.now();

    // Event loop delay — read percentiles then reset for the next window.
    const loopSample = {
      ts: now,
      p50Ms: this.eld.percentile(50) / 1e6,
      p95Ms: this.eld.percentile(95) / 1e6,
      p99Ms: this.eld.percentile(99) / 1e6,
      maxMs: this.eld.max / 1e6,
    };
    this.elRing.push(loopSample);
    this.eld.reset();

    // Write a stall down when it happens.
    //
    // The loop is where every HTTP handler, the scheduler and the
    // WebSocket run, so a stall here is every request stalling at once.
    // These samples were already collected — but only into a ring buffer
    // behind an admin route, so a stall at three in the morning left
    // nothing in the journal, no record of what the thread was doing and
    // no GC state. This is the line that makes the next one diagnosable
    // instead of merely known to have happened.
    if (loopSample.maxMs >= LOOP_STALL_WARN_MS) {
      const mem = process.memoryUsage();
      const gc =
        this.gcAccum.count > 0
          ? `gc=${this.gcAccum.count} in ${Math.round(this.gcAccum.totalMs)}ms, worst ${Math.round(this.gcAccum.maxMs)}ms ${this.gcAccum.maxKind || "unknown"}`
          : "gc=none";
      log.warn(
        `event loop stalled ${Math.round(loopSample.maxMs)}ms (p99 ${Math.round(loopSample.p99Ms)}ms); ` +
          `${gc}; heap=${formatGiB(mem.heapUsed)} rss=${formatGiB(mem.rss)}`,
      );
    }

    // CPU usage — delta since last tick, expressed as fraction of one core.
    const cpuDelta = process.cpuUsage(this.prevCpu);
    const wallUs = (now - this.prevCpuTs) * 1_000;
    const userPct = wallUs > 0 ? cpuDelta.user / wallUs : 0;
    const systemPct = wallUs > 0 ? cpuDelta.system / wallUs : 0;
    this.cpuRing.push({
      ts: now,
      userPct,
      systemPct,
      totalPct: userPct + systemPct,
    });
    this.prevCpu = process.cpuUsage();
    this.prevCpuTs = now;

    // Memory.
    const mem = process.memoryUsage();
    this.memRing.push({
      ts: now,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    });

    // GC pauses — flush accumulator.
    this.gcRing.push({
      ts: now,
      count: this.gcAccum.count,
      totalMs: this.gcAccum.totalMs,
      maxMs: this.gcAccum.maxMs,
    });
    this.gcAccum = { count: 0, totalMs: 0, maxMs: 0, maxKind: "" };
  }

  snapshot(windowSeconds: number): ProcessVitalsSnapshot {
    const cutoff = Date.now() - windowSeconds * 1_000;

    const elSamples = this.elRing.inWindow(cutoff);
    const cpuSamples = this.cpuRing.inWindow(cutoff);
    const memSamples = this.memRing.inWindow(cutoff);
    const gcSamples = this.gcRing.inWindow(cutoff);

    let meanTotalPct = 0;
    let peakTotalPct = 0;
    if (cpuSamples.length > 0) {
      let sum = 0;
      for (const s of cpuSamples) {
        sum += s.totalPct;
        if (s.totalPct > peakTotalPct) peakTotalPct = s.totalPct;
      }
      meanTotalPct = sum / cpuSamples.length;
    }

    let gcWindowTotalMs = 0;
    let gcWindowCount = 0;
    for (const s of gcSamples) {
      gcWindowTotalMs += s.totalMs;
      gcWindowCount += s.count;
    }

    return {
      windowSeconds,
      generatedAt: new Date().toISOString(),
      eventLoop: {
        current: this.elRing.latest(),
        samples: elSamples,
      },
      cpu: {
        current: this.cpuRing.latest(),
        samples: cpuSamples,
        meanTotalPct,
        peakTotalPct,
      },
      memory: {
        current: this.memRing.latest(),
        samples: memSamples,
      },
      gc: {
        current: this.gcRing.latest(),
        samples: gcSamples,
        windowTotalMs: gcWindowTotalMs,
        windowCount: gcWindowCount,
      },
    };
  }
}
