// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level vitals: event loop delay, CPU usage, memory, GC pauses.
 *
 * Samples four streams at 1 Hz into 600-element ring buffers (10 min).
 * `snapshot(windowSeconds)` returns the windowed view — same contract
 * as MetricsRegistry. Zero external dependencies; everything comes
 * from Node built-ins (`perf_hooks`, `process`).
 *
 * Stalls are not reported here: the stall monitor
 * (`observability/stall-monitor.ts`) detects each one from another thread
 * and names what was running, and reads the collections that overlapped it
 * from {@link ProcessVitalsCollector.gcBetween}.
 */

import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

import { Ring } from "./ring-buffer.js";
import type { GcWindow } from "./observability/stall-report.js";

const RING_SIZE = 600; // 10 min @ 1 Hz
/** Individual collections remembered for {@link ProcessVitalsCollector.gcBetween}. */
const GC_EVENT_RING_SIZE = 256;

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

interface GcEvent {
  /** Epoch ms the collection started. */
  ts: number;
  durationMs: number;
  kind: string;
}

export class ProcessVitalsCollector {
  private elRing = new Ring<EventLoopSample>(RING_SIZE);
  private cpuRing = new Ring<CpuUsageSample>(RING_SIZE);
  private memRing = new Ring<MemorySample>(RING_SIZE);
  private gcRing = new Ring<GcSample>(RING_SIZE);

  private eld = monitorEventLoopDelay({ resolution: 20 });
  private prevCpu = process.cpuUsage();
  private prevCpuTs = Date.now();

  private gcAccum = { count: 0, totalMs: 0, maxMs: 0 };
  private gcEvents = new Ring<GcEvent>(GC_EVENT_RING_SIZE);
  private gcObserver: PerformanceObserver;

  private interval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.eld.enable();

    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcAccum.count += 1;
        this.gcAccum.totalMs += entry.duration;
        if (entry.duration > this.gcAccum.maxMs) this.gcAccum.maxMs = entry.duration;
        this.gcEvents.push({
          ts: performance.timeOrigin + entry.startTime,
          durationMs: entry.duration,
          kind: gcKindName(entry),
        });
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
    this.gcAccum = { count: 0, totalMs: 0, maxMs: 0 };
  }

  /**
   * The collections that overlapped `[startMs, endMs]` (epoch ms), worst one
   * named by kind — a major collection on a large heap is a different
   * diagnosis from a string of minor ones. Null when there were none. Only
   * the last `GC_EVENT_RING_SIZE` collections are remembered, so for a long,
   * allocation-heavy span the count is a lower bound.
   */
  gcBetween(startMs: number, endMs: number): GcWindow | null {
    let found: GcWindow | null = null;
    for (const e of this.gcEvents.inWindow(Number.NEGATIVE_INFINITY)) {
      if (e.ts >= endMs || e.ts + e.durationMs <= startMs) continue;
      found ??= { count: 0, totalMs: 0, maxMs: 0, maxKind: "unknown" };
      found.count += 1;
      found.totalMs += e.durationMs;
      if (e.durationMs > found.maxMs) {
        found.maxMs = e.durationMs;
        found.maxKind = e.kind;
      }
    }
    return found;
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
