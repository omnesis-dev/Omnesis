// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory request + writer-queue metrics for /admin/metrics.
 *
 * Goal: answer "where is gateway latency going?" without leaving
 * the box. Records every authenticated HTTP request's
 * (totalMs, queueMs, execMs, calls) bucketed by (route template,
 * caller kind), plus a periodic snapshot of writer-worker queue
 * depth.
 *
 * Storage: one ring buffer of N=500 samples per (route,callerKind)
 * bucket, each sample is six numbers + a 64-bit timestamp. With
 * ~40 unique buckets (routes × {cli,portal,ios,collector,
 * unknown}) that's ~40*500*7*8 ≈ 1.1 MB upper bound. The /admin/
 * metrics endpoint computes p50/p95/p99 from the buffer on request
 * — cheap (O(N log N) per bucket once per query).
 *
 * Why ring buffer over hdr-histogram or Prometheus-style buckets:
 *   - tiny dependency footprint (none — single file, no npm pkg)
 *   - exact percentiles up to N samples, no histogram-bucket bias
 *   - rolling time windows trivially supported by filtering
 *   - per-sample inspection still possible if we ever want a
 *     "show me the slowest 10 requests in the last 5 minutes"
 *     debug endpoint (not done now, but the data is there)
 */

import { Ring } from "./ring-buffer.js";

const SAMPLES_PER_BUCKET = 500;

/** A category of HTTP caller, derived from the auth context's device.kind. */
export type CallerKind =
  | "cli"
  | "portal"
  | "ios"
  | "android"
  | "collector"
  | "agent"
  | "browser"
  | "unknown";

export interface RequestSample {
  ts: number; // Date.now() at sample time
  totalMs: number; // wall-clock from middleware entry to response
  writerQueueMs: number;
  writerExecMs: number;
  writerCalls: number;
  status: number; // HTTP status code
}

interface QueueDepthSample {
  ts: number;
  depth: number;
  /**
   * Per-priority breakdown of the depth at sample time. Lets the
   * Debug page show whether the queue is full of background work
   * (expected, draining slowly) or user work (anomaly worth
   * investigating).
   */
  byPriority?: { user: number; realtime: number; background: number };
}

export interface OpDepthRow {
  op: string;
  count: number;
  priority: "user" | "realtime" | "background";
}

const QUEUE_DEPTH_SAMPLES = 600; // 10 min @ 1Hz
/**
 * Ring buffer size for analytics-write samples. DuckDB writes are
 * serialised through a process-wide queue (see `AnalyticsDb.serializeWrite`),
 * so the busiest realistic ingest produces single-digit samples per
 * second; 500 covers ~10 minutes at 1Hz worst case.
 */
const ANALYTICS_WRITE_SAMPLES = 500;

export interface AnalyticsWriteSample {
  /** Wall-clock at sample time. */
  ts: number;
  /** Time the write spent waiting in `serializeWrite` before its turn. */
  waitMs: number;
  /** Time the write itself took once dequeued. */
  durationMs: number;
}

export interface AnalyticsWriteSummary {
  count: number;
  waitP50: number;
  waitP95: number;
  waitP99: number;
  durationP50: number;
  durationP95: number;
  durationP99: number;
}

export interface MetricsBucketSummary {
  route: string;
  callerKind: CallerKind;
  count: number;
  // total response time
  totalP50: number;
  totalP95: number;
  totalP99: number;
  // writer queue wait (sum across the request's writer calls)
  writerQueueP50: number;
  writerQueueP95: number;
  writerQueueP99: number;
  // writer exec time (sum across the request's writer calls)
  writerExecP50: number;
  writerExecP95: number;
  writerExecP99: number;
  /** Average writer-proxy calls per request. */
  meanWriterCalls: number;
  /** Count of HTTP error responses (>=500). */
  errorCount: number;
}

export interface MetricsSnapshot {
  windowSeconds: number;
  generatedAt: string;
  routes: MetricsBucketSummary[];
  writerQueue: {
    currentDepth: number;
    /** Peak depth seen in the window. */
    peakDepth: number;
    /** Mean depth in the window. */
    meanDepth: number;
    /** Samples over the window for sparkline display. */
    samples: QueueDepthSample[];
    /**
     * Per-op breakdown of the CURRENT pending queue (not historical).
     * Sorted by count desc — top entries surface what's filling
     * the queue right now.
     */
    byOp: OpDepthRow[];
  };
  /**
   * SQLITE_BUSY retries observed since last `clear()`. `total` covers
   * every retry across every op; `byOp` records the same broken down
   * by the optional op label callers pass to `recordBusyRetry`.
   * Lifetime counters — not windowed — so the operator can spot a
   * monotonic climb without tracking deltas across snapshots.
   */
  busyRetries: {
    total: number;
    byOp: Record<string, number>;
  };
  /**
   * Analytics-write queue stats over the window. Pairs queue-wait
   * (time spent waiting for the serialised write turn) with execution
   * time to surface the queue contention vs the work itself.
   */
  analyticsWrites: AnalyticsWriteSummary;
}

export class MetricsRegistry {
  private buckets = new Map<string, Ring<RequestSample>>();
  private queueDepth = new Ring<QueueDepthSample>(QUEUE_DEPTH_SAMPLES);
  private currentDepth = 0;
  private currentByOp: OpDepthRow[] = [];
  private busyRetryTotal = 0;
  private busyRetryByOp = new Map<string, number>();
  private analyticsWriteSamples = new Ring<AnalyticsWriteSample>(ANALYTICS_WRITE_SAMPLES);

  recordRequest(route: string, callerKind: CallerKind, sample: RequestSample): void {
    const key = `${route}\x00${callerKind}`;
    let ring = this.buckets.get(key);
    if (!ring) {
      ring = new Ring<RequestSample>(SAMPLES_PER_BUCKET);
      this.buckets.set(key, ring);
    }
    ring.push(sample);
  }

  /**
   * Record one SQLITE_BUSY retry. `op` is an optional caller-supplied
   * label so the snapshot's `byOp` can surface which write site is
   * burning retries — when one source's writes are pinning the
   * SQLite busy timeout, that's almost always where to look.
   */
  recordBusyRetry(op?: string): void {
    this.busyRetryTotal += 1;
    if (op) {
      this.busyRetryByOp.set(op, (this.busyRetryByOp.get(op) ?? 0) + 1);
    }
  }

  /**
   * Record one analytics write — both how long it waited in the
   * `serializeWrite` queue and how long the write itself took. See
   * `AnalyticsDb.serializeWrite` for the queue mechanics.
   */
  recordAnalyticsWrite(waitMs: number, durationMs: number): void {
    this.analyticsWriteSamples.push({ ts: Date.now(), waitMs, durationMs });
  }

  recordWriterQueueDepth(
    depth: number,
    byPriority?: { user: number; realtime: number; background: number },
    byOp?: OpDepthRow[],
  ): void {
    this.currentDepth = depth;
    if (byOp) this.currentByOp = byOp;
    this.queueDepth.push({ ts: Date.now(), depth, byPriority });
  }

  /**
   * Build a snapshot for the given window (seconds back from now).
   * Empty buckets (no samples in the window) are dropped from the
   * route list to keep the response readable.
   */
  snapshot(windowSeconds: number): MetricsSnapshot {
    const cutoff = Date.now() - windowSeconds * 1000;
    const routes: MetricsBucketSummary[] = [];
    for (const [key, ring] of this.buckets) {
      const idx = key.indexOf("\x00");
      const route = key.slice(0, idx);
      const callerKind = key.slice(idx + 1) as CallerKind;
      // Order doesn't matter here — every consumer below (percentile, count,
      // sum) is order-insensitive, and `percentile` sorts its input.
      const inWindow = ring.inWindow(cutoff);
      if (inWindow.length === 0) continue;
      const total = inWindow.map((s) => s.totalMs);
      const wq = inWindow.map((s) => s.writerQueueMs);
      const wx = inWindow.map((s) => s.writerExecMs);
      const callsSum = inWindow.reduce((a, s) => a + s.writerCalls, 0);
      const errorCount = inWindow.reduce((a, s) => a + (s.status >= 500 ? 1 : 0), 0);
      routes.push({
        route,
        callerKind,
        count: inWindow.length,
        totalP50: percentile(total, 0.5),
        totalP95: percentile(total, 0.95),
        totalP99: percentile(total, 0.99),
        writerQueueP50: percentile(wq, 0.5),
        writerQueueP95: percentile(wq, 0.95),
        writerQueueP99: percentile(wq, 0.99),
        writerExecP50: percentile(wx, 0.5),
        writerExecP95: percentile(wx, 0.95),
        writerExecP99: percentile(wx, 0.99),
        meanWriterCalls: callsSum / inWindow.length,
        errorCount,
      });
    }
    // Sort routes by p95 total descending — surface the worst offenders first.
    routes.sort((a, b) => b.totalP95 - a.totalP95);

    // `inWindow` returns samples ascending by ts — the Debug-page sparkline
    // assumes samples[0] is the oldest.
    const queueSamples = this.queueDepth.inWindow(cutoff);
    let peak = 0;
    let depthSum = 0;
    for (const s of queueSamples) {
      if (s.depth > peak) peak = s.depth;
      depthSum += s.depth;
    }
    const meanDepth = queueSamples.length > 0 ? depthSum / queueSamples.length : 0;

    const analyticsWaits: number[] = [];
    const analyticsDurations: number[] = [];
    for (const s of this.analyticsWriteSamples.inWindow(cutoff)) {
      analyticsWaits.push(s.waitMs);
      analyticsDurations.push(s.durationMs);
    }
    const analyticsWrites: AnalyticsWriteSummary = {
      count: analyticsWaits.length,
      waitP50: percentile(analyticsWaits, 0.5),
      waitP95: percentile(analyticsWaits, 0.95),
      waitP99: percentile(analyticsWaits, 0.99),
      durationP50: percentile(analyticsDurations, 0.5),
      durationP95: percentile(analyticsDurations, 0.95),
      durationP99: percentile(analyticsDurations, 0.99),
    };

    return {
      windowSeconds,
      generatedAt: new Date().toISOString(),
      routes,
      writerQueue: {
        currentDepth: this.currentDepth,
        peakDepth: peak,
        meanDepth,
        samples: queueSamples,
        byOp: this.currentByOp,
      },
      busyRetries: {
        total: this.busyRetryTotal,
        byOp: Object.fromEntries(this.busyRetryByOp),
      },
      analyticsWrites,
    };
  }

  /** Wipe all samples — used by tests. */
  clear(): void {
    this.buckets.clear();
    this.queueDepth = new Ring<QueueDepthSample>(QUEUE_DEPTH_SAMPLES);
    this.currentDepth = 0;
    this.currentByOp = [];
    this.busyRetryTotal = 0;
    this.busyRetryByOp.clear();
    this.analyticsWriteSamples = new Ring<AnalyticsWriteSample>(ANALYTICS_WRITE_SAMPLES);
  }
}

/**
 * Resolve a caller-kind from a device row. Falls back to "unknown"
 * for session-authenticated portal requests (no deviceId) — those
 * aren't logged as "portal" because we can't tell the kind without
 * the device row, and we don't want to misattribute.
 *
 * Pre-resolved server-side and passed in to avoid a DB lookup per
 * request — `recordRequest` is on the hot path.
 */
export function callerKindFromDeviceKind(kind: string | undefined): CallerKind {
  if (
    kind === "cli" ||
    kind === "portal" ||
    kind === "ios" ||
    kind === "android" ||
    kind === "collector" ||
    kind === "agent" ||
    kind === "browser"
  ) {
    return kind;
  }
  return "unknown";
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  // Caller passes raw (unsorted) values; sort a copy here.
  const arr = values.slice().sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.floor(p * arr.length));
  return arr[idx];
}
